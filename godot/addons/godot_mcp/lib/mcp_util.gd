@tool
extends RefCounted
## Shared helpers for the godot-mcp worker and editor plugin.
##
## Error convention: functions that can fail return a Dictionary
## `{"__error": {"code": String, "message": String, "context": Dictionary}}`.
## Use `is_fail()` to test and propagate it unchanged.

const ERR_KEY := "__error"


static func fail(code: String, message: String, context: Dictionary = {}) -> Dictionary:
	return {ERR_KEY: {"code": code, "message": message, "context": context}}


static func is_fail(value: Variant) -> bool:
	return typeof(value) == TYPE_DICTIONARY and (value as Dictionary).has(ERR_KEY)


static func ok(value: Variant) -> Dictionary:
	return {"value": value}


## Normalise a project-relative path to "res://...".
## Defence in depth: the TypeScript server already validated the path; this
## rejects anything that could still escape the project.
static func to_res_path(input: Variant) -> Variant:
	if typeof(input) != TYPE_STRING or (input as String).strip_edges().is_empty():
		return fail("INVALID_ARGUMENT", "Path must be a non-empty string")
	var p := (input as String).strip_edges().replace("\\", "/")
	if p.begins_with("res://"):
		p = p.substr(6)
	elif p.contains("://"):
		return fail("INVALID_ARGUMENT", "Only res:// paths are accepted: %s" % input)
	elif p.begins_with("/") or (p.length() > 1 and p[1] == ":"):
		return fail("PATH_OUTSIDE_PROJECT", "Absolute paths are not accepted here: %s" % input)
	var parts: PackedStringArray = []
	for seg in p.split("/"):
		if seg == "" or seg == ".":
			continue
		if seg == "..":
			return fail("PATH_OUTSIDE_PROJECT", "Path must not contain '..': %s" % input)
		parts.append(seg)
	if parts.is_empty():
		return fail("INVALID_ARGUMENT", "Path must name a file inside the project")
	var res := "res://" + "/".join(parts)
	var root := ProjectSettings.globalize_path("res://").simplify_path()
	var abs := ProjectSettings.globalize_path(res).simplify_path()
	if not abs.begins_with(root):
		return fail("PATH_OUTSIDE_PROJECT", "Path escapes the project: %s" % input)
	return res


static func ensure_dir_for(res_path: String) -> int:
	var dir := res_path.get_base_dir()
	if dir == "res://" or DirAccess.dir_exists_absolute(dir):
		return OK
	return DirAccess.make_dir_recursive_absolute(dir)


static func error_name(code: int) -> String:
	return error_string(code)


## Path of `node` relative to `root` ("." for the root itself).
static func rel_path(root: Node, node: Node) -> String:
	if node == root:
		return "."
	return str(root.get_path_to(node))


## Resolve a node path inside an instantiated (out-of-tree) scene.
## Accepts ".", "", "root", "root/A/B" (legacy form), "A/B" and "./A/B".
static func find_node(root: Node, path: Variant) -> Node:
	if path == null:
		return root
	var p := str(path).strip_edges()
	if p == "" or p == "." or p == "root" or p == "/root" or p == root.name:
		return root
	if p.begins_with("root/"):
		p = p.substr(5)
	elif p.begins_with("./"):
		p = p.substr(2)
	elif p.begins_with(str(root.name) + "/"):
		p = p.substr(str(root.name).length() + 1)
	if p.begins_with("/"):
		return null
	return root.get_node_or_null(NodePath(p))


## Set owner on `node` and every descendant that has no owner yet (or was
## owned by `old_owner`), without touching nodes that belong to an instanced
## sub-scene.
static func adopt(node: Node, new_owner: Node, old_owner: Node = null) -> void:
	if node != new_owner and (node.owner == null or node.owner == old_owner):
		node.owner = new_owner
	if node != new_owner and not node.scene_file_path.is_empty():
		return # instanced sub-scene: its internals keep their own owner
	for c in node.get_children():
		adopt(c, new_owner, old_owner)


static func valid_node_name(name: String) -> bool:
	if name.strip_edges().is_empty():
		return false
	return name.validate_node_name() == name


## Compact JSON-safe description of an Error code.
static func godot_error(code: int, what: String) -> Dictionary:
	return fail("OPERATION_FAILED", "%s failed: %s (%d)" % [what, error_string(code), code], {"godot_error": code})


## UID of a resource file. ResourceLoader.get_resource_uid() only consults the
## UID cache, which does not exist until the editor has scanned the project,
## so fall back to the .uid sidecar or the text resource header.
static func read_uid(path: String) -> int:
	var id := ResourceLoader.get_resource_uid(path)
	if id != ResourceUID.INVALID_ID:
		return id
	if FileAccess.file_exists(path + ".uid"):
		return ResourceUID.text_to_id(FileAccess.get_file_as_string(path + ".uid").strip_edges())
	if path.get_extension().to_lower() in ["tscn", "tres"] and FileAccess.file_exists(path):
		var f := FileAccess.open(path, FileAccess.READ)
		if f != null:
			var header := f.get_line()
			f.close()
			var m := RegEx.create_from_string("uid=\"(uid://[a-z0-9]+)\"").search(header)
			if m != null:
				return ResourceUID.text_to_id(m.get_string(1))
	return ResourceUID.INVALID_ID


## Make a file's UID known to ResourceUID so references written by the saver
## carry uid="..." like editor-saved files do.
static func register_uid(path: String) -> int:
	var id := read_uid(path)
	if id != ResourceUID.INVALID_ID:
		if ResourceUID.has_id(id):
			ResourceUID.set_id(id, path)
		else:
			ResourceUID.add_id(id, path)
	return id


## Save `res` to `path`, keeping the file's existing UID (or assigning a new
## one, as the editor does for new files).
static func save_resource(res: Resource, path: String) -> int:
	var id := read_uid(path) if FileAccess.file_exists(path) else ResourceUID.INVALID_ID
	if id == ResourceUID.INVALID_ID:
		id = ResourceUID.create_id()
	var err := ResourceSaver.save(res, path)
	if err != OK:
		return err
	err = ResourceSaver.set_uid(path, id)
	if err != OK:
		return err
	if path.get_extension().to_lower() in ["tscn", "tres"]:
		err = _restore_ext_resource_uids(path)
		if err != OK:
			return err
	if ResourceUID.has_id(id):
		ResourceUID.set_id(id, path)
	else:
		ResourceUID.add_id(id, path)
	return OK


static func uid_text(path: String) -> String:
	var id := read_uid(path)
	return ResourceUID.id_to_text(id) if id != ResourceUID.INVALID_ID else ""


## Outside the editor, Godot's text saver writes [ext_resource] entries with
## a path but without the uid="..." attribute that editor-saved files carry.
## Re-add the UID of every referenced file that has one so headless edits do
## not strip resource identity from existing references (documented in
## docs/limitations.md). Only the attribute is inserted; nothing else changes.
static func _restore_ext_resource_uids(path: String) -> int:
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		return OK
	var re := RegEx.create_from_string("^\\[ext_resource type=\"([^\"]+)\" path=\"(res://[^\"]+)\"")
	var lines := text.split("\n")
	var changed := false
	for i in lines.size():
		var line: String = lines[i]
		if not line.begins_with("[ext_resource ") or line.contains(" uid=\""):
			continue
		var m := re.search(line)
		if m == null:
			continue
		var uid := uid_text(m.get_string(2))
		if uid.is_empty():
			continue
		lines[i] = line.replace("type=\"%s\" path=" % m.get_string(1), "type=\"%s\" uid=\"%s\" path=" % [m.get_string(1), uid])
		changed = true
	if not changed:
		return OK
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return FileAccess.get_open_error()
	f.store_string("\n".join(lines))
	f.close()
	return OK


## Register the UID of every scene/resource/script in the project with
## ResourceUID, the way the editor's filesystem scan does. Without this, a
## headless process that has no (or a stale) .godot/uid_cache.bin cannot
## resolve uid:// references and warns "invalid UID - using text path".
## Reads only file headers / .uid sidecars; bounded by `limit` files.
static func register_project_uids(limit: int = 50000) -> int:
	var count := [0]
	_register_dir("res://", count, limit)
	return count[0]


static func _register_dir(dir: String, count: Array, limit: int) -> void:
	var da := DirAccess.open(dir)
	if da == null:
		return
	for f in da.get_files():
		if count[0] >= limit:
			return
		var path := dir.path_join(f)
		var ext := f.get_extension().to_lower()
		if ext in ["tscn", "tres"] or (ext == "uid" and f.length() > 4):
			var target := path.trim_suffix(".uid") if ext == "uid" else path
			var id := read_uid(target)
			if id != ResourceUID.INVALID_ID and not ResourceUID.has_id(id):
				ResourceUID.add_id(id, target)
				count[0] += 1
	for sub in da.get_directories():
		if sub.begins_with("."):
			continue
		_register_dir(dir.path_join(sub), count, limit)
