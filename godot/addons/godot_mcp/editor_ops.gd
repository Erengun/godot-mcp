@tool
extends RefCounted
## Editor-side operations for the MCP bridge. Every mutation goes through
## EditorUndoRedoManager so the user can undo it with Ctrl+Z, and only the
## currently edited scene is modified (never a scene file behind the editor's
## back).

const U = preload("lib/mcp_util.gd")
const C = preload("lib/variant_codec.gd")
const P = preload("lib/class_policy.gd")

var plugin: EditorPlugin
var _logger: EditorLogger


class EditorLogger extends Logger:
	var records: Array = []
	var _mutex := Mutex.new()
	const LIMIT := 300
	const SEVERITY := ["error", "warning", "script_error", "shader_error"]

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _bt: Array[ScriptBacktrace]) -> void:
		_mutex.lock()
		records.append({"severity": SEVERITY[error_type] if error_type < SEVERITY.size() else "error", "message": rationale if not rationale.is_empty() else code, "file": file, "line": line, "function": function, "time": Time.get_ticks_msec()})
		if records.size() > LIMIT:
			records.pop_front()
		_mutex.unlock()

	func _log_message(_m: String, _e: bool) -> void:
		pass

	func since(t: int) -> Array:
		_mutex.lock()
		var out := records.filter(func(r): return r["time"] >= t)
		_mutex.unlock()
		return out


func _init(p: EditorPlugin) -> void:
	plugin = p
	_logger = EditorLogger.new()
	OS.add_logger(_logger)


func shutdown() -> void:
	if _logger != null:
		OS.remove_logger(_logger)
		_logger = null


func dispatch(method: String, params: Dictionary) -> Variant:
	match method:
		"status": return status()
		"scene_state": return scene_state(params)
		"scene_tree": return scene_tree(params)
		"selection_get": return selection_get()
		"selection_set": return selection_set(params)
		"open_scene": return open_scene(params)
		"save_scene": return save_scene(params)
		"reload_scene": return reload_scene(params)
		"set_properties": return set_properties(params)
		"add_node": return add_node(params)
		"remove_node": return remove_node(params)
		"filesystem_scan": return filesystem_scan(params)
		"play": return play(params)
		"stop_playing": return stop_playing()
		"errors": return errors(params)
	return U.fail("INVALID_ARGUMENT", "Unknown editor method '%s'" % method)


## Scenes open in the editor with unsaved changes. Godot added
## get_unsaved_scenes() in 4.7; older editors do not say, so every open scene
## is treated as possibly unsaved (headless writes to it are refused, and
## reloading it asks for discardUnsaved).
static func _unsaved_scenes() -> Array:
	if EditorInterface.has_method("get_unsaved_scenes"):
		return Array(EditorInterface.call("get_unsaved_scenes"))
	return Array(EditorInterface.get_open_scenes())


func status() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	return {
		"project_root": ProjectSettings.globalize_path("res://"),
		"project_name": ProjectSettings.get_setting("application/config/name", ""),
		"godot_version": Engine.get_version_info().get("string", ""),
		"edited_scene": root.scene_file_path if root != null else null,
		"open_scenes": Array(EditorInterface.get_open_scenes()),
		"unsaved_scenes": _unsaved_scenes(),
		"unsaved_tracking": EditorInterface.has_method("get_unsaved_scenes"),
		"playing": EditorInterface.is_playing_scene(),
		"playing_scene": EditorInterface.get_playing_scene(),
		"filesystem_scanning": EditorInterface.get_resource_filesystem().is_scanning(),
		# (EditorFileSystem.is_importing() arrived in Godot 4.7.)
		"importing": EditorInterface.get_resource_filesystem().call("is_importing") if EditorInterface.get_resource_filesystem().has_method("is_importing") else false,
	}


func scene_state(params: Dictionary) -> Variant:
	var p = U.to_res_path(params.get("path"))
	if U.is_fail(p):
		return p
	var open := Array(EditorInterface.get_open_scenes())
	var unsaved := _unsaved_scenes()
	return {"path": p, "open": p in open, "unsaved": p in unsaved, "edited": EditorInterface.get_edited_scene_root() != null and EditorInterface.get_edited_scene_root().scene_file_path == p}


func _edited_root() -> Variant:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return U.fail("NOT_FOUND", "No scene is open in the editor")
	return root


func _check_scene(params: Dictionary, root: Node) -> Variant:
	# Guard against editing a different scene than the caller intended.
	if params.has("scene") and params["scene"] != null and str(params["scene"]) != "":
		var want = U.to_res_path(params["scene"])
		if U.is_fail(want):
			return want
		if root.scene_file_path != want:
			return U.fail("CONFLICT", "The edited scene is %s, not %s; open it first (open_scene)" % [root.scene_file_path, want])
	return null


func _node(root: Node, path: Variant) -> Variant:
	var n := U.find_node(root, path)
	if n == null:
		return U.fail("NOT_FOUND", "Node not found in the edited scene: %s" % path)
	return n


func scene_tree(params: Dictionary) -> Variant:
	var root = _edited_root()
	if U.is_fail(root):
		return root
	var max_depth := int(params.get("max_depth", 4))
	var selected := EditorInterface.get_selection().get_selected_nodes()
	var out := []
	_walk(root, root, 0, max_depth, selected, bool(params.get("include_properties", false)), out)
	return {"scene": root.scene_file_path, "unsaved": root.scene_file_path in _unsaved_scenes(), "nodes": out}


func _walk(root: Node, n: Node, depth: int, max_depth: int, selected: Array, props: bool, out: Array) -> void:
	if out.size() >= 1000:
		return
	var e := {"path": U.rel_path(root, n), "type": n.get_class(), "name": str(n.name)}
	if n in selected:
		e["selected"] = true
	if n.get_script() is Script:
		e["script"] = n.get_script().resource_path
	if n != root and not n.scene_file_path.is_empty():
		e["instance"] = n.scene_file_path
	if props:
		e["properties"] = C.stored_properties(n, 1, 32)
	out.append(e)
	if depth >= max_depth:
		return
	for c in n.get_children():
		if c.owner == root or c.owner == null and c == root or (c.owner != null and root.is_editable_instance(c.owner)):
			_walk(root, c, depth + 1, max_depth, selected, props, out)


func selection_get() -> Variant:
	var root := EditorInterface.get_edited_scene_root()
	var out := []
	for n in EditorInterface.get_selection().get_selected_nodes():
		out.append({"path": U.rel_path(root, n) if root != null else str(n.name), "type": n.get_class()})
	return {"scene": root.scene_file_path if root != null else null, "selected": out}


func selection_set(params: Dictionary) -> Variant:
	var root = _edited_root()
	if U.is_fail(root):
		return root
	var nodes := []
	for p in params.get("nodes", []):
		var n = _node(root, p)
		if U.is_fail(n):
			return n
		nodes.append(n)
	var sel := EditorInterface.get_selection()
	sel.clear()
	for n in nodes:
		sel.add_node(n)
	if nodes.size() == 1:
		EditorInterface.edit_node(nodes[0])
	return selection_get()


func open_scene(params: Dictionary) -> Variant:
	var p = U.to_res_path(params.get("path"))
	if U.is_fail(p):
		return p
	if not ResourceLoader.exists(p):
		return U.fail("NOT_FOUND", "Scene does not exist: %s" % p)
	EditorInterface.open_scene_from_path(p)
	var root := EditorInterface.get_edited_scene_root()
	return {"opened": p, "edited_scene": root.scene_file_path if root != null else null}


func save_scene(params: Dictionary) -> Variant:
	var root = _edited_root()
	if U.is_fail(root):
		return root
	var bad = _check_scene(params, root)
	if bad != null:
		return bad
	var err := EditorInterface.save_scene()
	if err != OK:
		return U.godot_error(err, "EditorInterface.save_scene")
	return {"saved": root.scene_file_path, "uid": U.uid_text(root.scene_file_path)}


func reload_scene(params: Dictionary) -> Variant:
	var p = U.to_res_path(params.get("path"))
	if U.is_fail(p):
		return p
	if p in _unsaved_scenes() and not bool(params.get("discard_unsaved", false)):
		return U.fail("CONFLICT", "%s has unsaved changes in the editor; refusing to reload (pass discard_unsaved: true only if the user agreed to lose them)" % p)
	if not p in Array(EditorInterface.get_open_scenes()):
		return {"reloaded": false, "reason": "scene is not open"}
	EditorInterface.reload_scene_from_path(p)
	return {"reloaded": true, "path": p}


func set_properties(params: Dictionary) -> Variant:
	var root = _edited_root()
	if U.is_fail(root):
		return root
	var bad = _check_scene(params, root)
	if bad != null:
		return bad
	var n = _node(root, params.get("node", "."))
	if U.is_fail(n):
		return n
	var props = params.get("properties")
	if typeof(props) != TYPE_DICTIONARY or (props as Dictionary).is_empty():
		return U.fail("INVALID_ARGUMENT", "properties must be a non-empty object")
	# Decode and validate everything first; nothing is applied on error.
	var staged := []
	for k in C.ordered_keys(props):
		var key := str(k)
		if key.contains(":"):
			return U.fail("INVALID_ARGUMENT", "Sub-property paths are not supported in live edits; set the whole value")
		if key in C.FORBIDDEN_PROPERTIES:
			return U.fail("INVALID_ARGUMENT", "Property '%s' cannot be set directly" % key)
		if key.begins_with("metadata/"):
			# Metadata is not in the property list until it exists (null removes it).
			if not key.substr(9).is_valid_identifier():
				return U.fail("INVALID_ARGUMENT", "Metadata name '%s' must be a valid identifier" % key.substr(9))
			var mv = C.decode(props[k], {}, {"node": n, "root": root, "self_path": root.scene_file_path})
			if U.is_fail(mv):
				return mv
			staged.append([key, mv, n.get_meta(key.substr(9), null)])
			continue
		var info := C.property_info(n, key)
		if info.is_empty():
			return U.fail("NOT_FOUND", "%s has no property '%s'" % [n.get_class(), key], {"suggestions": C.suggest(n, key)})
		# The same rules as headless edits (variant_codec.set_property()).
		if key.begins_with("_") or (int(info["usage"]) & PROPERTY_USAGE_INTERNAL and not key in C.SETTABLE_INTERNAL):
			return U.fail("INVALID_ARGUMENT", "Property '%s' is internal and cannot be set" % key)
		if int(info["usage"]) & PROPERTY_USAGE_READ_ONLY:
			return U.fail("INVALID_ARGUMENT", "Property '%s' is read-only" % key)
		var v = C.decode(props[k], info, {"node": n, "root": root, "self_path": root.scene_file_path})
		if U.is_fail(v):
			return v
		staged.append([key, v, n.get(key)])
	var ur := plugin.get_undo_redo()
	ur.create_action("MCP: set %d propert%s on %s" % [staged.size(), "y" if staged.size() == 1 else "ies", n.name], UndoRedo.MERGE_DISABLE, root)
	for s in staged:
		ur.add_do_property(n, s[0], s[1])
		ur.add_undo_property(n, s[0], s[2])
	ur.commit_action()
	var applied := {}
	for s in staged:
		applied[s[0]] = C.encode(n.get(s[0]), 1)
	return {"node": U.rel_path(root, n), "properties": applied, "unsaved": true}


func add_node(params: Dictionary) -> Variant:
	var root = _edited_root()
	if U.is_fail(root):
		return root
	var bad = _check_scene(params, root)
	if bad != null:
		return bad
	var parent = _node(root, params.get("parent", "."))
	if U.is_fail(parent):
		return parent
	var name := str(params.get("name", ""))
	if not U.valid_node_name(name):
		return U.fail("INVALID_ARGUMENT", "Invalid node name '%s'" % name)
	if (parent as Node).has_node(NodePath(name)):
		return U.fail("CONFLICT", "'%s' already has a child named '%s'" % [U.rel_path(root, parent), name])
	var n = P.create(str(params.get("type", "")), "Node")
	if U.is_fail(n):
		return n
	n.name = name
	var props = params.get("properties", {})
	if typeof(props) == TYPE_DICTIONARY:
		for k in props.keys():
			var r = C.set_property(n, str(k), props[k], {"node": n, "root": root, "self_path": root.scene_file_path})
			if U.is_fail(r):
				n.free()
				return r
	var ur := plugin.get_undo_redo()
	ur.create_action("MCP: add %s" % name, UndoRedo.MERGE_DISABLE, root)
	ur.add_do_method(parent, "add_child", n, true)
	ur.add_do_property(n, "owner", root)
	ur.add_do_reference(n)
	ur.add_undo_method(parent, "remove_child", n)
	ur.commit_action()
	return {"path": U.rel_path(root, n), "type": n.get_class(), "unsaved": true}


func _owned(root: Node, n: Node, out: Array) -> void:
	for c in n.get_children():
		if c.owner == root:
			out.append(c)
		_owned(root, c, out)


func remove_node(params: Dictionary) -> Variant:
	var root = _edited_root()
	if U.is_fail(root):
		return root
	var bad = _check_scene(params, root)
	if bad != null:
		return bad
	var n = _node(root, params.get("node"))
	if U.is_fail(n):
		return n
	if n == root:
		return U.fail("INVALID_ARGUMENT", "The scene root cannot be removed")
	if n.owner != root:
		return U.fail("CONFLICT", "Node belongs to an instanced sub-scene and cannot be removed here")
	var parent: Node = n.get_parent()
	var idx: int = n.get_index()
	var owned := []
	_owned(root, n, owned)
	var ur := plugin.get_undo_redo()
	ur.create_action("MCP: remove %s" % n.name, UndoRedo.MERGE_DISABLE, root)
	ur.add_do_method(parent, "remove_child", n)
	ur.add_undo_method(parent, "add_child", n, true)
	ur.add_undo_method(parent, "move_child", n, idx)
	ur.add_undo_property(n, "owner", root)
	for d in owned:
		ur.add_undo_property(d, "owner", root)
	ur.add_undo_reference(n)
	ur.commit_action()
	return {"removed": params.get("node"), "unsaved": true, "undoable": true}


func filesystem_scan(params: Dictionary) -> Variant:
	var fs := EditorInterface.get_resource_filesystem()
	var files: Array = params.get("files", [])
	if files.is_empty():
		fs.scan()
		return {"scan_started": true}
	for f in files:
		var p = U.to_res_path(f)
		if U.is_fail(p):
			return p
		fs.update_file(p)
	return {"updated": files.size()}


func play(params: Dictionary) -> Variant:
	var which := str(params.get("scene", "main"))
	if which == "main":
		EditorInterface.play_main_scene()
	elif which == "current":
		EditorInterface.play_current_scene()
	else:
		var p = U.to_res_path(which)
		if U.is_fail(p):
			return p
		EditorInterface.play_custom_scene(p)
	return {"playing": true, "scene": which}


func stop_playing() -> Variant:
	EditorInterface.stop_playing_scene()
	return {"playing": false}


func errors(params: Dictionary) -> Variant:
	return {"errors": _logger.since(int(params.get("since_ms", 0))) if _logger != null else [], "now_ms": Time.get_ticks_msec()}
