extends RefCounted
## Keeps scenes and resources from silently losing scripts or stored values
## when they are re-saved headlessly.
##
## Godot refuses to attach a script that did not load or compile, so
## instantiating a scene (or loading a .tres) that uses one silently drops the
## script reference and every script-defined value, and the next save writes
## the file without them. Scripts that use autoload singletons do compile: the
## worker registers every autoload name with an inert placeholder node (see
## mcp_worker.gd), exactly as a running game registers them before any script
## loads, without running the autoloads themselves.
##
## Before a file is loaded for writing, `prepare()` checks the scripts it
## depends on (recursively through instanced scenes and resources); writes are
## refused when one does not load or compile, since nothing could keep it.
## After saving, `verify_scene()`, `verify_resource()` and `text_loss()` compare
## the result with the original as a last line of defence.

const U = preload("../../addons/godot_mcp/lib/mcp_util.gd")

## path -> "ok" | "broken" | "missing"
static var _status := {}
## PackedScene instance id -> [the file it was loaded from, the baseline] (see remember_source()).
static var _sources := {}
## path -> parsed text of a scene or resource file (see _file_sections()),
## cleared when a save is verified.
static var _parsed_files := {}
## class -> {property name: true}
static var _native_props := {}
## Actions that name a node without rewriting its stored data (apart from the
## properties they set, which are recorded separately).
const _VALUE_NEUTRAL_ACTIONS := ["add_node", "remove_node", "rename_node", "move_node", "reparent_node", "reorder_node", "duplicate_node", "instantiate_scene", "set_properties", "attach_script", "detach_script", "connect_signal", "disconnect_signal", "add_to_group", "remove_from_group", "set_editable_children"]
## Stored properties that hold a node's local transform.
const _TRANSFORM_KEYS := {"position": true, "rotation": true, "scale": true, "skew": true, "transform": true, "quaternion": true, "basis": true, "rotation_degrees": true, "rotation_edit_mode": true, "offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true, "size": true, "layout_mode": true, "anchors_preset": true, "anchor_left": true, "anchor_top": true, "anchor_right": true, "anchor_bottom": true, "grow_horizontal": true, "grow_vertical": true}
## Placement properties -> the stored keys that change with them. "origin"
## exempts only the origin of a Transform3D/Transform2D, not its basis.
const _OFFSETS := {"offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true}
const _STORED_AS := {
	"position": {"transform": "origin", "offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true},
	"rotation": {"transform": true, "quaternion": true, "basis": true},
	"rotation_degrees": {"rotation": true, "transform": true, "quaternion": true, "basis": true},
	"quaternion": {"transform": true, "rotation": true, "basis": true},
	"basis": {"transform": true, "rotation": true, "quaternion": true},
	"scale": {"transform": true},
	"transform": {"position": true, "rotation": true, "scale": true, "skew": true, "quaternion": true, "basis": true},
	"size": {"offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true},  # which offsets follow depends on grow direction (Godot 4.8+)
	"anchor_left": {"anchors_preset": true, "offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true},
	"anchor_top": {"anchors_preset": true, "offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true},
	"anchor_right": {"anchors_preset": true, "offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true},
	"anchor_bottom": {"anchors_preset": true, "offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true},
	"anchors_preset": {"anchor_left": true, "anchor_top": true, "anchor_right": true, "anchor_bottom": true, "offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true, "grow_horizontal": true, "grow_vertical": true},
	"layout_mode": {"anchors_preset": true, "anchor_left": true, "anchor_top": true, "anchor_right": true, "anchor_bottom": true, "offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true},
}
## Control layout keys that a new parent (a container) may rewrite.
const _LAYOUT_KEYS := {"offset_left": true, "offset_top": true, "offset_right": true, "offset_bottom": true, "size": true, "layout_mode": true, "anchors_preset": true, "anchor_left": true, "anchor_top": true, "anchor_right": true, "anchor_bottom": true, "grow_horizontal": true, "grow_vertical": true, "position": true}
## Stored keys Godot derives from others when a scene loads (a Control's
## anchors_preset follows its anchors, which are compared).
const _DERIVED_KEYS := {"anchors_preset": true}
## Actions whose result reports the node's resolved path.
const _RESOLVED_PATH_ACTIONS := ["set_properties", "attach_script", "detach_script", "remove_node", "set_editable_children", "add_to_group", "remove_from_group"]


## Returns {"broken": [descriptions]}; callers that write must refuse when it
## is not empty (see refusal()). Covers scripts that do not load or compile,
## direct dependencies that cannot be loaded (deleted, or not imported yet) and
## node or resource types whose class is not available (a GDExtension that is
## not loaded): Godot would load the file without them and save it that way.
static func prepare(path: String) -> Dictionary:
	var out := {"broken": []}
	_walk(path, {}, 0, out)
	for dep in ResourceLoader.get_dependencies(path):
		var p := _dep_path(str(dep))
		if p.is_empty():
			out["broken"].append("%s (dependency that cannot be resolved)" % str(dep).get_slice("::", 0))
		elif not p.get_extension().to_lower() in ["gd", "cs"] and not ResourceLoader.exists(p):
			out["broken"].append("%s (missing, or not imported yet)" % p)
	if path.get_extension().to_lower() in ["tscn", "tres"]:
		var seen := {}
		for m in RegEx.create_from_string("(?m)^\\[(?:node|sub_resource|gd_resource) [^\\n]*? type=\"([^\"]+)\"").search_all(FileAccess.get_file_as_string(path)):
			var cls := m.get_string(1)
			if not ClassDB.class_exists(cls) and not seen.has(cls):
				seen[cls] = true
				out["broken"].append("class %s (not available; is its GDExtension loaded?)" % cls)
	return out


## Whether `path` depends on `target`, directly or through other files.
static func depends_on(path: String, target: String) -> bool:
	var seen := {path: true}
	var queue := [path]
	while not queue.is_empty() and seen.size() < 10000:
		var cur: String = queue.pop_back()
		for dep in ResourceLoader.get_dependencies(cur):
			var p := _dep_path(str(dep))
			if p == target:
				return true
			if not p.is_empty() and not seen.has(p) and p.get_extension().to_lower() in ["tscn", "scn", "tres", "res"]:
				seen[p] = true
				queue.append(p)
	return false


static func refusal(path: String, broken: Array) -> Dictionary:
	return U.fail("OPERATION_FAILED", "%s uses script(s) or resources that do not compile or cannot be loaded: %s. Godot would load it without them and save it that way, so nothing was written. Fix them first (godot_script_validate, godot_import) or make this change in the Godot editor (godot_editor)." % [path, ", ".join(broken)], {"broken_dependencies": broken})


static func binary_refusal(path: String, scripted: Array) -> Dictionary:
	return U.fail("OPERATION_FAILED", "%s is a binary file with scripted resources (%s). Their values are loaded through their scripts and cannot be verified after saving, so nothing was written. Save it as .tscn/.tres in the Godot editor, or make this change there (godot_editor)." % [path, ", ".join(scripted)], {"scripted_resources": scripted})


static func _walk(path: String, visited: Dictionary, depth: int, out: Dictionary) -> void:
	if visited.has(path) or depth > 32:
		return
	visited[path] = true
	for dep in ResourceLoader.get_dependencies(path):
		var p := _dep_path(str(dep))
		if p.is_empty():
			continue
		var ext := p.get_extension().to_lower()
		if ext in ["gd", "cs"]:
			# Includes scripts that do not load at all (a .cs file without .NET):
			# the loaded scene would silently lack them.
			if check_script(p) != "ok" and not p in out["broken"]:
				out["broken"].append(p)
		elif ext in ["tscn", "scn", "tres", "res"]:
			_walk(p, visited, depth + 1, out)


## Dependency strings look like "res://a.gd::Script" or "uid://x::Script::res://a.gd".
static func _dep_path(dep: String) -> String:
	for part in dep.split("::"):
		if part.begins_with("res://"):
			return part
	var first := dep.get_slice("::", 0)
	if first.begins_with("uid://"):
		var id := ResourceUID.text_to_id(first)
		if id != ResourceUID.INVALID_ID and ResourceUID.has_id(id):
			return ResourceUID.get_id_path(id)
	return ""


static func check_script(path: String) -> String:
	if _status.has(path):
		return _status[path]
	var status := "ok"
	var s = ResourceLoader.load(path, "Script")
	if s == null or not (s is Script):
		status = "missing"
	elif not (s as Script).can_instantiate():
		status = "broken"
	_status[path] = status
	return status


## Scripts built into the scene file (sub-resources) that do not compile.
static func broken_builtin_scripts(ps: PackedScene) -> Array:
	var out := []
	_builtin_walk(ps.get_state(), out, 0)
	return out


static func _builtin_walk(st: SceneState, out: Array, depth: int) -> void:
	if st == null or depth > 32:
		return
	for i in st.get_node_count():
		for j in st.get_node_property_count(i):
			if st.get_node_property_name(i, j) != "script":
				continue
			var s = st.get_node_property_value(i, j)
			if s is Script and (s as Script).resource_path.contains("::") and not (s as Script).can_instantiate():
				var label := "%s (built-in script of node '%s')" % [(s as Script).resource_path, st.get_node_path(i)]
				if not label in out:
					out.append(label)
		var inst = st.get_node_instance(i)
		if inst is PackedScene:
			_builtin_walk((inst as PackedScene).get_state(), out, depth + 1)
	_builtin_walk(st.get_base_scene_state(), out, depth + 1)


## Scripted resources stored inside a binary (.scn/.res) file. Their values
## were loaded through their scripts (setters may have changed them), and a
## binary file cannot be compared as text afterwards, so writes are refused.
static func binary_scripted(path: String, loaded: Resource) -> Array:
	if not path.get_extension().to_lower() in ["scn", "res"]:
		return []
	var ctx := {"main": loaded} if not (loaded is PackedScene) else {"state": (loaded as PackedScene).get_state()}
	var out := []
	var all := _sub_resources(ctx)
	if not (loaded is PackedScene):
		all["(main resource)"] = loaded
	for id in all:
		var r = all[id]
		if r is Resource and (r as Resource).get_script() is Script and not ((r as Resource).get_script() as Script).resource_path.is_empty():
			out.append("%s::%s (script %s)" % [path, id, ((r as Resource).get_script() as Script).resource_path])
	return out


## The text form of a resource (a binary scene or resource), written to the
## worker's private temporary directory, for text_loss(). "" when unavailable.
static func text_of(res: Resource, name: String) -> String:
	var dir := str(Engine.get_meta("godot_mcp_tmp", ""))
	if dir.is_empty() or res == null:
		return ""
	var tmp := dir.path_join(name + (".tscn" if res is PackedScene else ".tres"))
	if ResourceSaver.save(res, tmp) != OK:
		return ""
	var text := FileAccess.get_file_as_string(tmp)
	DirAccess.remove_absolute(tmp)
	return text


## Record the file a scene was loaded from, so that saving it can compare the
## result with that file's text.
static func remember_source(ps: PackedScene, path: String) -> void:
	# The baseline is taken now, before anything is instantiated (see text_loss()).
	_sources[ps.get_instance_id()] = [path, text_of(ps, "baseline")]


static func source_of(ps: PackedScene) -> String:
	return _sources.get(ps.get_instance_id(), ["", ""])[0] if ps != null else ""


static func baseline_of(ps: PackedScene) -> String:
	return _sources.get(ps.get_instance_id(), ["", ""])[1] if ps != null else ""


## Compare the packed result of an edit with the scene as it was loaded. Every
## node of the edited file must keep its script unless an action re-scripted
## it, no node may gain a `script = null` override, and every stored script
## variable an action did not set must keep its value (a setter that runs while
## the scene loads can fail, or transform the value, before storing it; a
## typed property can reject it). A value may only disappear from the re-pack
## when the instance still holds it, i.e. it equals the default. Native
## properties are not checked. `touched` comes from touched_by(); `root` may be
## null when only the script references matter. Returns "" or a description of
## what would be lost.
static func verify_scene(original: PackedScene, packed: PackedScene, root: Node, touched: Dictionary) -> String:
	_parsed_files.clear()  # files an earlier save may have rewritten
	var before := original.get_state()
	var after := packed.get_state()
	var events: Array = touched.get("events", [])
	var tree_changed := _tree_changed(events)
	var after_index := {}
	for i in after.get_node_count():
		after_index[_norm(after.get_node_path(i))] = i
	var lost := []
	var mapped := {}  # saved-file paths of the original's nodes
	for i in before.get_node_count():
		var fate := _fate(_norm(before.get_node_path(i)), events)
		var path: String = fate["path"]
		if path.is_empty() or not after_index.has(path):
			continue
		mapped[path] = true
		var old_props := _props(before, i)
		var new_props := _props(after, after_index[path])
		if fate["rescripted"]:
			continue
		if old_props.has("script") and not _same_script(old_props["script"], new_props.get("script")):
			lost.append("%s: script %s" % [path, _label(old_props["script"])])
		if root == null:
			continue
		var node := root if path == "." else root.get_node_or_null(NodePath(path))
		var script = node.get_script() if node != null else null
		if not (script is Script):
			continue
		var script_vars := _script_vars(script)
		for k in old_props:
			if not script_vars.has(k) or fate["keys"].has(k) or not _is_set(old_props[k]):
				continue
			if tree_changed and _has_node_path(old_props[k]):
				# The node it points to may have been removed or renamed on
				# purpose; the rest of the value may not change (nor may a
				# value that holds more than node paths be dropped).
				var ot := var_to_str(old_props[k])
				var before_path := _norm(before.get_node_path(i))
				# (A value missing here is compared as text: SceneState does not
				# list every node reference it stores.)
				if new_props.has(k) and not _paths_explained(ot, var_to_str(new_props[k]), before_path, path, events):
					lost.append("%s: property '%s'" % [path, k])
				continue
			if not _equivalent(old_props[k], new_props[k] if new_props.has(k) else node.get(k)):
				lost.append("%s: property '%s'" % [path, k])
		# A value the file did not store (it equalled the default or the
		# instanced scene's value) must not turn into a different one.
		for k in new_props:
			if script_vars.has(k) and not old_props.has(k) and not fate["keys"].has(k):
				lost.append("%s: property '%s' would change" % [path, k])
	# Nodes the actions created may only store what the actions set (or, for a
	# duplicate, what its source stores).
	var set_keys := _set_keys_by_final(events)
	var rescripted := _final_rescripted(events)
	var defined := {}  # nodes the saved scene defines in full
	for i in after.get_node_count():
		if not after.get_node_type(i).is_empty() or after.get_node_instance(i) != null:
			defined[_norm(after.get_node_path(i))] = true
	if root != null:
		for i in after.get_node_count():
			var path := _norm(after.get_node_path(i))
			if mapped.has(path):
				continue
			var node := root if path == "." else root.get_node_or_null(NodePath(path))
			var script = node.get_script() if node != null else null
			if not (script is Script):
				continue
			var script_vars := _script_vars(script)
			var exempt: Dictionary = set_keys.get(path, {})
			var ref := _copy_ref(path, events)
			if not ref.is_empty() and (str(ref["src"]).is_empty() or rescripted.has(path) or not str(_source_changed(events, ref["i"])["why"]).is_empty() or not _uncheckable_source(defined, root, _forward(events[ref["i"]]["source"], events, ref["i"] + 1)).is_empty()):
				continue  # the text comparison refuses or explains it
			var source: String = ref.get("src", "")
			var source_props := _props(after, after_index[source]) if after_index.has(source) else {}
			var new_props := _props(after, i)
			for k in new_props:
				if not script_vars.has(k) or exempt.has(k):
					continue
				if source_props.has(k) and _equivalent(source_props[k], new_props[k]):
					continue
				var source_node := root if source == "." else root.get_node_or_null(NodePath(source))
				if not source.is_empty() and source_node != null and _equivalent(new_props[k], source_node.get(k)):
					continue  # a duplicate stores what its source holds (e.g. from its instanced scene)
				lost.append("%s: property '%s' would be stored as a changed value" % [path, k])
	for i in after.get_node_count():
		var path := _norm(after.get_node_path(i))
		var new_props := _props(after, i)
		if new_props.has("script") and new_props["script"] == null and not rescripted.has(path):
			lost.append("%s: would gain a 'script = null' override" % path)
	return "; ".join(lost)


static func _script_vars(script: Script) -> Dictionary:
	var out := {}
	for p in script.get_script_property_list():
		if int(p["usage"]) & PROPERTY_USAGE_SCRIPT_VARIABLE:
			out[str(p["name"])] = true
	return out


static func _is_set(v: Variant) -> bool:
	return typeof(v) != TYPE_NIL and not (v is NodePath and (v as NodePath).is_empty())


## Whether `cur` (the re-packed value, or what the instance holds) still is the
## stored value `old`. A stored node path matches the node it resolved to.
static func _equivalent(old: Variant, cur: Variant) -> bool:
	if old is NodePath:
		return cur is Node or (cur is NodePath and cur == old)
	if old is Array:
		if not (cur is Array) or (cur as Array).size() != (old as Array).size():
			return false
		for i in (old as Array).size():
			if not _equivalent(old[i], cur[i]):
				return false
		return true
	if old is Dictionary:
		if not (cur is Dictionary) or (cur as Dictionary).size() != (old as Dictionary).size():
			return false
		for k in old:
			if not (cur as Dictionary).has(k) or not _equivalent(old[k], cur[k]):
				return false
		return true
	if old is Resource and cur is Resource and _built_in(old) and _built_in(cur):
		return true  # sub-resources: their content is compared as text (text_loss)
	if old is Object:
		return is_same(old, cur)
	if typeof(old) in [TYPE_INT, TYPE_FLOAT] and typeof(cur) in [TYPE_INT, TYPE_FLOAT]:
		return float(old) == float(cur)
	if typeof(old) in [TYPE_STRING, TYPE_STRING_NAME] and typeof(cur) in [TYPE_STRING, TYPE_STRING_NAME]:
		return str(old) == str(cur)
	return typeof(old) == typeof(cur) and old == cur


static func _built_in(r: Resource) -> bool:
	return r.resource_path.is_empty() or r.resource_path.contains("::")


static func _has_node_path(v: Variant) -> bool:
	if v is NodePath:
		return true
	if v is Array:
		return (v as Array).any(func(e): return _has_node_path(e))
	if v is Dictionary:
		return (v as Dictionary).keys().any(func(e): return _has_node_path(e)) or (v as Dictionary).values().any(func(e): return _has_node_path(e))
	return false


static func _props(st: SceneState, i: int) -> Dictionary:
	var out := {}
	for j in st.get_node_property_count(i):
		out[str(st.get_node_property_name(i, j))] = st.get_node_property_value(i, j)
	return out


static func _same_script(a: Variant, b: Variant) -> bool:
	if not (a is Script) or not (b is Script):
		return a == b
	var pa := (a as Script).resource_path
	var pb := (b as Script).resource_path
	if pa.contains("::") or pb.contains("::"):
		# Built-in scripts get new sub-resource ids when saved; compare their code.
		return pa.contains("::") and pb.contains("::") and (a as Script).source_code == (b as Script).source_code
	return pa == pb


static func _label(s: Variant) -> String:
	return (s as Script).resource_path if s is Script else str(s)


static func _norm(p: NodePath) -> String:
	var s := str(p)
	return "." if s == "." else s.trim_prefix("./")


## Action node paths as scene_edit resolves them ("." or "root" is the root,
## legacy "root/..." prefixes are accepted).
static func _action_path(raw: String) -> String:
	var s := raw.strip_edges().trim_prefix("./")
	if s in ["", ".", "root"]:
		return "."
	return s.trim_prefix("root/")


## Nodes in `skip`, or below a subtree entry (keys ending in "/").
static func _skipped(path: String, skip: Dictionary) -> bool:
	if skip.has(path):
		return true
	for k in skip:
		if str(k).ends_with("/") and (path + "/").begins_with(str(k)):
			return true
	return false


## What the actions of a batch legitimately change, as an ordered list of
## events in the scene's paths at the time: {"t": "rename", "old", "new"},
## {"t": "remove", "path"}, {"t": "rescript", "path"} (attach/detach_script)
## and {"t": "set", "path", "keys"} (properties an action set). `results` are
## the actions' results (they carry the old and new path of moved nodes).
static func touched_by(actions: Array, results: Array = []) -> Dictionary:
	var events := []
	for i in actions.size():
		var a = actions[i]
		if typeof(a) != TYPE_DICTIONARY:
			continue
		var r = results[i] if i < results.size() and typeof(results[i]) == TYPE_DICTIONARY else {}
		var raw = a.get("node", a.get("node_path", a.get("path")))
		var node := _action_path(str(raw)) if raw != null else ""
		var kind := str(a.get("action", ""))
		if kind in _RESOLVED_PATH_ACTIONS and r.has("path"):
			node = _action_path(str(r["path"]))  # as resolved (%Unique, the root's name...)
		match kind:
			"remove_node":
				events.append({"t": "remove", "path": node})
			"rename_node", "move_node", "reparent_node":
				if r.has("old_path") and r.has("path"):
					events.append({"t": "rename", "old": _action_path(str(r["old_path"])), "new": _action_path(str(r["path"]))})
					if kind != "rename_node":
						events.append({"t": "reorder", "path": _action_path(str(r["path"]))})
						# A new parent re-lays out a Control; keeping the global
						# transform rewrites the local one.
						var keys := _LAYOUT_KEYS.duplicate() if bool(r.get("control", false)) else {}
						if bool(a.get("keep_global_transform", false)):
							keys.merge(_TRANSFORM_KEYS)
						if not keys.is_empty():
							events.append({"t": "set", "path": _action_path(str(r["path"])), "keys": keys, "move": true})
				else:
					events.append({"t": "remove", "path": node})  # destination unknown: not compared
			"attach_script", "detach_script":
				events.append({"t": "rescript", "path": node})
			"add_node", "instantiate_scene":
				if r.has("path"):
					events.append({"t": "new", "path": _action_path(str(r["path"]))})
			"set_editable_children":
				# Only a change counts (asking for the state it already has explains nothing).
				if r.get("changed", true):
					if r.get("editable", true) == false:
						events.append({"t": "uneditable", "path": node})
					else:
						events.append({"t": "editable", "path": node})
			"disconnect_signal", "connect_signal":
				# Resolved ends; an already existing connection reports none.
				if r.has("from") and r.has("to"):
					events.append({"t": kind.trim_suffix("_signal"), "signal": str(r.get("signal", "")), "method": str(r.get("method", "")), "from": _action_path(str(r["from"])), "to": _action_path(str(r["to"]))})
			"add_to_group", "remove_from_group":
				events.append({"t": "group", "path": node, "group": str(a.get("group", "")), "add": kind == "add_to_group"})
			"reorder_node":
				if r.has("path"):
					events.append({"t": "reorder", "path": _action_path(str(r["path"]))})
			"duplicate_node":
				if r.has("path") and r.has("source"):
					events.append({"t": "duplicate", "path": _action_path(str(r["path"])), "source": _action_path(str(r["source"]))})
		var authored = raw if raw != null else a.get("player")
		if authored != null and not kind in _VALUE_NEUTRAL_ACTIONS:
			# Authoring actions (animation, TileMap, GridMap...) rewrite the node's
			# data and the sub-resources it holds.
			events.append({"t": "set", "path": _action_path(str(authored)), "keys": {"*": true}})
		var props = a.get("properties")
		if typeof(props) == TYPE_DICTIONARY:
			var target := _action_path(str(r["path"])) if kind in ["add_node", "instantiate_scene"] and r.has("path") else node
			if not target.is_empty() or raw != null:
				var keys := {}
				for k in props:
					keys[str(k)] = true
					# Godot stores a node's placement under other keys (transform,
					# offset_*...), which change along with the one that was set.
					keys.merge(_STORED_AS.get(str(k).trim_prefix("global_"), {}))
				events.append({"t": "set", "path": target, "keys": keys})
	return {"events": events}


## `p` (a path at the time of event `from`) in the saved file's paths ("" when
## a later action removed it).
static func _forward(p: String, events: Array, from: int) -> String:
	for j in range(from, events.size()):
		p = _step(p, events[j])
		if p.is_empty():
			return ""
	return p


## Whether path `p` is `a` or below it.
static func _covers(a: String, p: String) -> bool:
	return p == a or (a != "." and p.begins_with(a + "/"))


## Per saved-file path, the properties that actions set on that node.
static func _set_keys_by_final(events: Array) -> Dictionary:
	var out := {}
	for i in events.size():
		if events[i]["t"] == "set":
			var final := _forward(events[i]["path"], events, i + 1)
			if not final.is_empty():
				(out.get_or_add(final, {}) as Dictionary).merge(events[i]["keys"])
	return out


## When `final` (a saved-file path) is a node that duplicate_node made, or a
## child of one: {"i": that duplicate event, "at": the source's path then,
## "root": whether it is the copy itself, "src": the source's saved-file path
## ("" when it was removed)}. {} when it is not a copy.
static func _copy_ref(final: String, events: Array) -> Dictionary:
	var p := final
	for j in range(events.size() - 1, -1, -1):
		var e: Dictionary = events[j]
		match e["t"]:
			"rename":
				if e["old"] != "." and _covers(e["new"], p):
					p = e["old"] + p.substr(str(e["new"]).length())
			"remove", "new":
				if _covers(e["path"], p):
					return {}  # made later by something else
			"duplicate":
				if _covers(e["path"], p):
					var at: String = str(e["source"]) + p.substr(str(e["path"]).length())
					return {"i": j, "at": at, "root": p == e["path"], "src": _forward(at, events, j + 1)}
	return {}


## For a node created by duplicate_node: the saved-file path of its source.
static func _duplicate_source(final: String, events: Array) -> String:
	return str(_copy_ref(final, events).get("src", ""))


## Whether actions after duplicate event `i` changed its source (or a node
## below it): {"why": "" or what happened, "keys": layout keys a move set}.
## A copy is compared with its source as saved, which must still be what
## was copied.
static func _source_changed(events: Array, i: int) -> Dictionary:
	var src: String = events[i]["source"]
	var keys := {}
	var added := []  # nodes added below the source since (not copied)
	for k in range(i + 1, events.size()):
		var e: Dictionary = events[k]
		var at := str(e.get("path", e.get("from", "")))
		if not at.is_empty() and added.any(func(n): return _covers(n, at)):
			continue
		match e["t"]:
			"remove":
				if _covers(e["path"], src):
					return {"why": "removed", "keys": keys}
				if _covers(src, e["path"]):
					return {"why": "changed", "keys": keys}
			"rename":
				src = _step(src, e)
				for n in added.size():
					added[n] = _step(added[n], e)
			"new", "duplicate":
				if _covers(src, e["path"]):
					added.append(e["path"])
			"set":
				if _covers(src, e["path"]):
					return {"why": "changed", "keys": keys}
			"rescript", "group", "editable", "uneditable":
				if _covers(src, e["path"]):
					return {"why": "changed", "keys": keys}
			"connect", "disconnect":
				if _covers(src, e["from"]):
					return {"why": "changed", "keys": keys}  # its connections are copied
	return {"why": "", "keys": keys}


## Section paths (as saved) of the nodes the file defines in full: their own
## type or instance, rather than overrides of a node another scene defines.
static func _defined_paths(after: Dictionary) -> Dictionary:
	var out := {}
	for id in after["order"]:
		if after["headers"][id].has("type") or after["headers"][id].has("instance"):
			out[id] = true
	return out


## Why the source of a copy (`src`, a saved-file path) cannot be checked, or
## "". Only nodes the edited file defines in full can be compared: a node an
## inherited scene defines, or one that belongs to an instanced scene, is
## stored only as overrides (and Godot's duplicate does not even keep the
## children an instance owns).
static func _uncheckable_source(defined: Dictionary, root: Node, src: String) -> String:
	if root == null or src.is_empty():
		return ""
	var n: Node = root if src == "." else root.get_node_or_null(NodePath(src))
	if n == null:
		return ""
	var stack := [n]
	while not stack.is_empty():
		var d: Node = stack.pop_back()
		var p := _norm(root.get_path_to(d))
		if d.owner != root and d != root:
			if d == n:
				return "%s is part of an instanced scene" % p
			stack.append_array(d.get_children())  # the instance's own node (overrides only)
			continue
		if not defined.has(p):
			return "%s comes from an inherited or instanced scene" % p
		# An instance is copied as an instance (its own nodes come from its
		# scene file, with this file's overrides); nodes this file adds under
		# its editable children are owned by the scene and copied with it.
		stack.append_array(d.get_children())
	return ""


## Saved-file paths of nodes that move_node/reparent_node/reorder_node placed.
static func _placed(events: Array) -> Dictionary:
	var out := {}
	for i in events.size():
		if events[i]["t"] == "reorder" and events[i].has("path"):
			var p := _forward(events[i]["path"], events, i + 1)
			if not p.is_empty():
				out[p] = true
	return out


## Follow a node of the original file through the events: its path in the
## saved file ("" when it was removed), whether it was re-scripted, and the
## properties actions set on it.
static func _fate(path: String, events: Array) -> Dictionary:
	var out := {"path": path, "rescripted": false, "keys": {}}
	for e in events:
		var cur: String = out["path"]
		match e["t"]:
			"rename", "remove":
				out["path"] = _step(cur, e)
				if str(out["path"]).is_empty():
					return out
			"rescript":
				if cur == e["path"]:
					out["rescripted"] = true
			"set":
				if cur == e["path"]:
					out["keys"].merge(e["keys"])
	return out


## Path `cur` after a rename or remove event ("" when it removed the node).
static func _step(cur: String, e: Dictionary) -> String:
	if e["t"] == "rename" and e["old"] != "." and (cur == e["old"] or cur.begins_with(e["old"] + "/")):
		return e["new"] + cur.substr(str(e["old"]).length())
	if e["t"] == "remove" and (e["path"] == "." or cur == e["path"] or cur.begins_with(e["path"] + "/")):
		return ""
	return cur


static func _parent_of(p: String) -> String:
	return p.get_base_dir() if p.contains("/") else "."


## Saved-file paths of parents whose children an action added, removed or
## moved in or out (their children's index may change).
static func _disturbed_parents(events: Array) -> Dictionary:
	var out := {}
	for i in events.size():
		var e: Dictionary = events[i]
		var parents := []
		match e["t"]:
			"remove":
				parents.append(_forward(_parent_of(e["path"]), events, i + 1))
			"rename":
				if _parent_of(e["old"]) != _parent_of(e["new"]):
					parents.append(_forward(_parent_of(e["old"]), events, i + 1))
					parents.append(_forward(_parent_of(e["new"]), events, i + 1))
			"new", "duplicate":
				var p := _forward(e["path"], events, i + 1)
				if not p.is_empty():
					parents.append(_parent_of(p))
		for p in parents:
			if not str(p).is_empty():
				out[p] = true  # ("" : the parent itself was removed later)
	return out


static func _tree_changed(events: Array) -> bool:
	return events.any(func(e): return e["t"] in ["rename", "remove"])


## Paths, in the saved file, of nodes whose script an action changed.
static func _final_rescripted(events: Array) -> Dictionary:
	var out := {}
	for i in events.size():
		if events[i]["t"] == "rescript":
			out[_forward(events[i]["path"], events, i + 1)] = true
	return out


## "" when `back` (the saved file, reloaded) still has the script `had_script`.
static func verify_resource(had_script: Script, back: Resource) -> String:
	_parsed_files.clear()
	if had_script == null:
		return ""
	if back == null or not (back.get_script() is Script) or (back.get_script() as Script).resource_path != had_script.resource_path:
		return "the script %s would be dropped" % had_script.resource_path
	return ""


# ------------------------------------------------------------ text comparison

## Compare a saved .tscn/.tres with the text it was loaded from: apart from
## what the actions explain, the saved file must say what the original said.
## In every [node], [resource] and [sub_resource] section present in both,
## every stored key must keep its value (sub-resources are compared by
## content, so a copy under a new id is the same value), and no key may
## appear. A key may only disappear when the object still holds the same value
## as a stored property (it equals the default, so the saver omits it), or
## when it is not a property at all any more (an obsolete key Godot drops); in
## that case a native property may appear in the same section (a renamed
## property). A [node] section that defines a node (type= or instance=) or
## stores values must not disappear, nor change its type or instanced scene,
## and no [connection] may disappear. This covers every way a value can get
## changed or lost (setters, _set, _validate_property, missing dependencies),
## including what verify_scene() cannot see.
## `ctx`: "root" (the edited scene's root node), "main" (the saved resource) or
## "state" (the saved scene's SceneState), "events" (see touched_by()) and
## "keys" (properties edited on the main resource). Returns "" or a
## description of what would be lost.
static func text_loss(before_text: String, after_text: String, ctx: Dictionary) -> String:
	var issues := _issues(before_text, after_text, ctx)
	# Godot upgrades data written by older versions when it loads a file (renamed
	# keys, new value encodings). `baseline` is the original as Godot itself
	# re-saves it right after loading it, before anything is instantiated: a
	# difference in native data that it shows too is such an upgrade, not a
	# loss. Loading runs the scripts of scripted resources, which could change
	# native data before the baseline is taken, so files that contain any are
	# held to the original throughout. Script values, metadata and scripted
	# resources always are.
	var baseline: String = ctx.get("baseline", "")
	if not baseline.is_empty() and not issues.is_empty() and not _has_scripted_resources(before_text):
		var also := {}
		for it in _issues(baseline, after_text, ctx):
			also[it["key"]] = true
		issues = issues.filter(func(it): return it["strict"] or also.has(it["key"]))
	return "; ".join(issues.map(func(it): return it["msg"]))


static var _SUB_REF := RegEx.create_from_string("SubResource\\(\"([^\"]+)\"\\)")


## The exemption of a key an action set a sub-path of (`a` for `a:b`): not
## an exemption of its own (see _exemptions()).
const _SUB_PATH := 2


## Whether the node paths in stored value text `nv` (saved, for the node at
## `node_after`) are explained by those in `ov` (original, for the node at
## `node_before`; "" for a sub-resource) and the batch, the rest being the
## same: each path is unchanged, follows its node's rename or move, or is
## empty when its node was removed.
static func _paths_explained(ov: String, nv: String, node_before: String, node_after: String, events: Array, node_typed: Variant = null) -> bool:
	var a := []
	var b := []
	if not _same_value_text(_mask_paths(ov, a), _mask_paths(nv, b)) or a.size() != b.size():
		return false
	for i in a.size():
		# A plain NodePath keeps its text; a node-typed export is stored as
		# the path to the node it holds (null when that node was removed).
		# Not knowing which (`node_typed` null), either is accepted.
		if a[i] == b[i] and node_typed != true:
			continue
		if node_typed == false:
			return false
		var target := _path_target(a[i], node_before, events)
		if target.is_empty():
			if a[i] == b[i]:
				continue
			return false
		if target["now"] == "":
			if b[i] != "" and b[i] != _NULL_PATH:
				return false
		elif b[i] != _relative(node_after, target["now"]) + target["suffix"]:
			return false
	return true


## Whether every node path in stored value text `ov` (of the node at
## `node_before`) points to a node the batch removed, and the value holds
## nothing else.
static func _targets_removed(ov: String, node_before: String, events: Array) -> bool:
	if not _only_paths(ov):
		return false
	var tokens := []
	_mask_paths(ov, tokens)
	for t in tokens:
		if t != _NULL_PATH and t != "":
			var target := _path_target(t, node_before, events)
			if target.is_empty() or target["now"] != "":
				return false
	return true


## Where node path `p` (relative to the node at `node_before`) points after
## the batch: {"now": its saved-file path, or "" when removed; "suffix": the
## `:property` part}, or {} when that cannot be worked out.
static func _path_target(p: String, node_before: String, events: Array) -> Dictionary:
	if node_before.is_empty() or p == _NULL_PATH or p.begins_with("/") or p.begins_with("%"):
		return {}
	var node_part := p.get_slice(":", 0)
	var suffix := p.substr(node_part.length())
	var parts: Array = [] if node_before == "." else Array(node_before.split("/"))
	for seg in node_part.split("/"):
		if seg == "..":
			if parts.is_empty():
				return {}
			parts.pop_back()
		elif seg != "." and seg != "":
			if seg.begins_with("%"):
				return {}
			parts.append(seg)
	var abs_path := "." if parts.is_empty() else "/".join(parts)
	return {"now": _fate(abs_path, events)["path"], "suffix": suffix}


## Whether Godot itself converts one of the dropped `obsolete` keys (key ->
## stored value text) of `obj` into key `k`: `k` is a sub-key of it (such as
## `libraries/` from `libraries`), or setting it on a new object of the same
## engine class (so no project code runs) changes `k`.
static func _converted(obj: Object, obsolete: Dictionary, k: String) -> bool:
	for o in obsolete:
		if k.begins_with(str(o) + "/"):
			return true
	var cls := obj.get_class()
	if not ClassDB.can_instantiate(cls):
		return false
	for o in obsolete:
		var text: String = obsolete[o]
		if text.contains("Resource(") or text.contains("Object("):
			continue
		var fresh: Object = ClassDB.instantiate(cls)
		var was = fresh.get(k)
		fresh.set(str(o), str_to_var(text))
		var now = fresh.get(k)
		if fresh is Node:
			(fresh as Node).free()
		elif not (fresh is RefCounted):
			fresh.free()
		if typeof(was) != typeof(now) or was != now:
			return true
	return false


## Whether node-typed export value `bv` of copy `copy` matches value `av`
## of its source `src`: each path points (from the copy) to the node the
## source's points to, or to its counterpart among the nodes duplicate
## event `at` (of `src_root`, as saved) made, followed through later renames.
static func _copy_paths_match(av: String, bv: String, src: String, copy: String, src_root: String, events: Array, at: int) -> bool:
	var a := []
	var b := []
	if not _same_value_text(_mask_paths(av, a), _mask_paths(bv, b)) or a.size() != b.size():
		return false
	for i in a.size():
		if a[i] == b[i] and (a[i] == "" or a[i] == _NULL_PATH):
			continue
		var target := _path_target(a[i], src, [])
		if target.is_empty():
			return false
		var t: String = target["now"]
		var ok := [_relative(copy, t) + target["suffix"]]
		if not src_root.is_empty() and (t == src_root or t.begins_with(src_root + "/")):
			var twin := _forward(str(events[at]["path"]) + t.substr(src_root.length()), events, at + 1)
			if not twin.is_empty():
				ok.append(_relative(copy, twin) + target["suffix"])
		if not ok.has(b[i]):
			return false
	return true


## The node path from the node at `from` to the node at `to` (both saved-file
## paths).
static func _relative(from: String, to: String) -> String:
	var fp: Array = [] if from == "." else Array(from.split("/"))
	var tp: Array = [] if to == "." else Array(to.split("/"))
	var common := 0
	while common < fp.size() and common < tp.size() and fp[common] == tp[common]:
		common += 1
	var out := []
	for i in fp.size() - common:
		out.append("..")
	out.append_array(tp.slice(common))
	return "." if out.is_empty() else "/".join(out)


## Whether a stored value text refers to a node path.
static func _mentions_path(v: String) -> bool:
	return v.contains("NodePath(") or v.contains("^\"")


## Whether a stored value text holds nothing but node paths (and nulls), in a
## collection or not.
static func _only_paths(v: String) -> bool:
	if not _mentions_path(v):
		return false
	var rest := _mask_paths(v).replace("NodePath(\"\")", "")
	rest = RegEx.create_from_string("Array\\[[A-Za-z0-9_]+\\]").sub(rest, "", true)
	for c in rest:
		if not c in "[](), \t\r\n":
			return false
	return true


## A null among the node paths of _mask_paths().
const _NULL_PATH := "@null"


## A stored value text with each node path (`NodePath("…")`, `^"…"`) and
## each null outside strings written as `NodePath("")`; appends each one's
## text (or _NULL_PATH) to `tokens`.
static func _mask_paths(v: String, tokens: Array = []) -> String:
	var out := ""
	var i := 0
	var n := v.length()
	while i < n:
		var c := v[i]
		if c == "\"":
			var e := _string_end(v, i)
			out += v.substr(i, e - i)
			i = e
			continue
		var lit := -1  # where a path's string literal starts
		if v.substr(i, 10) == "NodePath(\"":
			lit = i + 9
		elif c == "^" and i + 1 < n and v[i + 1] == "\"":
			lit = i + 1
		elif v.substr(i, 4) == "null" and (i == 0 or not _is_word(v[i - 1])) and (i + 4 >= n or not _is_word(v[i + 4])):
			out += "NodePath(\"\")"
			tokens.append(_NULL_PATH)
			i += 4
			continue
		if lit >= 0:
			var e := _string_end(v, lit)
			tokens.append(v.substr(lit + 1, e - lit - 2).c_unescape())
			if c == "N" and e < n and v[e] == ")":
				e += 1
			out += "NodePath(\"\")"
			i = e
			continue
		out += c
		i += 1
	return out


## The index just past the string literal whose opening quote is at `at`.
static func _string_end(v: String, at: int) -> int:
	var i := at + 1
	while i < v.length():
		if v[i] == "\\":
			i += 2
			continue
		if v[i] == "\"":
			return i + 1
		i += 1
	return v.length()


static func _is_word(c: String) -> bool:
	return c == "_" or (c >= "a" and c <= "z") or (c >= "A" and c <= "Z") or (c >= "0" and c <= "9")


## An exemption that covers the whole key (not only a Transform's origin).
static func _is_full(v: Variant) -> bool:
	return typeof(v) == TYPE_BOOL and v


## Keys a re-scripted node's script owns: "script", and anything that is not a
## native property of the node's class.
static func _script_owned(obj: Object, k: String) -> bool:
	return k == "script" or obj == null or (not k.begins_with("metadata/") and not _native_has(obj.get_class(), k))


## A Transform2D/Transform3D text without its origin (the last 2 or 3 numbers).
static func _without_origin(t: String) -> String:
	var m := RegEx.create_from_string("^(Transform[23]D)\\(([^)]*)\\)$").search(t)
	if m == null:
		return t
	var nums := m.get_string(2).split(",")
	nums.resize(nums.size() - (2 if m.get_string(1) == "Transform2D" else 3))
	return "%s(%s)" % [m.get_string(1), ",".join(nums)]


static func _has_scripted_resources(text: String) -> bool:
	var file := _sections(text)
	for id in file["sections"]:
		if (id == "resource" or str(id).begins_with("sub:")) and (file["sections"][id] as Dictionary).has("script"):
			return true
	return false


static func _issues(before_text: String, after_text: String, ctx: Dictionary) -> Array:
	var before := _sections(before_text)
	var after := _sections(after_text)
	var events: Array = ctx.get("events", [])
	var tree_changed := _tree_changed(events)
	var exempt := _exemptions(before, after, events, ctx.get("keys", {}))
	var placed := _placed(events)  # an action set their place among their siblings
	var disturbed := _disturbed_parents(events)
	for p in placed:
		disturbed[_parent_of(p)] = true
	var subs = null  # sub-resource id -> object, built on first use
	var lost := []
	# Which stored values share a sub-resource: each original sub-resource (or
	# the source of a copy Godot makes of a resource local to the scene) pairs
	# with exactly one saved sub-resource and the other way round, whatever
	# ids the save gives them.
	var shares := {"l": {}, "s": {}, "scope": {}}
	var mapped := {}  # node sections of the saved file that come from the original
	for id in before["sections"]:
		var is_node: bool = not (id == "resource" or str(id).begins_with("sub:"))
		var after_id: String = id
		if is_node:
			var fate := _fate(id, events)
			if str(fate["path"]).is_empty() or _under_uneditable(fate["path"], events):
				continue
			mapped[fate["path"]] = true
			after_id = fate["path"]
		if not after["sections"].has(after_id):
			if is_node and _defines_node(before, id):
				lost.append({"key": "node|" + id, "msg": "node %s would be dropped" % id, "strict": false})
			continue
		if is_node:
			for attr in ["type", "instance"]:
				if before["headers"][id].get(attr, "") != after["headers"][after_id].get(attr, ""):
					lost.append({"key": "node|" + id, "msg": "node %s: its %s would change" % [id, attr], "strict": false})
			if _expected_groups(before["headers"][id].get("groups", "[]"), after_id, events) != after["headers"][after_id].get("groups", "[]"):
				lost.append({"key": "groups|" + id, "msg": "node %s: its groups would change" % id, "strict": false})
		var label := _section_label(after_id)
		var keys_exempt: Dictionary = exempt.get(after_id, {})
		var old_keys: Dictionary = before["sections"][id]
		var new_keys: Dictionary = after["sections"][after_id]
		var obj: Object = null
		if id == "resource":
			obj = ctx.get("main")
		elif is_node:
			var root: Node = ctx.get("root")
			if root != null:
				obj = root if after_id == "." else root.get_node_or_null(NodePath(after_id))
		else:
			if subs == null:
				subs = _sub_resources(ctx)
			obj = subs.get(str(id).trim_prefix("sub:"))
		var script = obj.get_script() if obj != null else null
		var script_vars := _script_vars(script) if script is Script else {}
		var scripted_resource: bool = not is_node and (script is Script or old_keys.has("script"))
		# A node an action re-scripted keeps its native values; its script and
		# script values are the action's to change.
		var rescripted: bool = is_node and _fate(id, events)["rescripted"]
		var obsolete := {}  # keys that are no longer properties -> their values
		for k in old_keys:
			var strict: bool = scripted_resource or k == "script" or k.begins_with("metadata/") or script_vars.has(k)
			# An authoring action's wildcard covers native data only.
			if _DERIVED_KEYS.has(k) or _is_full(keys_exempt.get(k)) or (keys_exempt.has("*") and not strict) or (rescripted and _script_owned(obj, k)):
				continue
			var ov := _canon(old_keys[k], before, after, exempt)
			if typeof(keys_exempt.get(k)) == TYPE_STRING:
				if new_keys.has(k) and _without_origin(ov) != _without_origin(_canon(new_keys[k], after, before, exempt)):
					lost.append({"key": "%s|%s" % [after_id, k], "msg": "%s: '%s' would change" % [label, k], "strict": false})
				continue
			var has_paths: bool = tree_changed and _mentions_path(ov)
			var typed: bool = is_node and ((before["headers"][id].get("node_paths", {}) as Dictionary).has(k) or (after["headers"].get(after_id, {}).get("node_paths", {}) as Dictionary).has(k))
			if has_paths and typed and not new_keys.has(k) and _targets_removed(ov, id, events) and _defined_value(ctx.get("root"), obj, k) in [null, [null]]:
				continue  # the nodes it held were removed (and nothing else defines it)
			if new_keys.has(k):
				if not _pair_refs(old_keys[k], new_keys[k], before, after, exempt, shares):
					lost.append({"key": "%s|%s" % [after_id, k], "msg": "%s: '%s' would change which values share a resource" % [label, k], "strict": strict})
					continue
				if ov.contains("Sub{"):
					# what an action set in a sub-resource is skipped on both sides
					ov = _canon(old_keys[k], before, after, _exempt_for_original(exempt, shares))
				if has_paths:
					# The node a path points to may have been removed or
					# renamed on purpose; the rest of the value may not change.
					if not _paths_explained(ov, _canon(new_keys[k], after, before, exempt), id if is_node else "", after_id, events, typed):
						lost.append({"key": "%s|%s" % [after_id, k], "msg": "%s: '%s' would change" % [label, k], "strict": strict})
					continue
				if not _same_value_text(ov, _canon(new_keys[k], after, before, exempt)):
					lost.append({"key": "%s|%s" % [after_id, k], "msg": "%s: '%s' would change" % [label, k], "strict": strict})
				continue
			match _vanish(obj, k, ov):
				"default":
					pass
				"obsolete":
					obsolete[k] = old_keys[k]
				_:
					lost.append({"key": "%s|%s" % [after_id, k], "msg": "%s: '%s' would be dropped" % [label, k], "strict": strict})
		for k in new_keys:
			var strict: bool = scripted_resource or k == "script" or k.begins_with("metadata/") or script_vars.has(k)
			if old_keys.has(k) or _DERIVED_KEYS.has(k) or _is_full(keys_exempt.get(k)) or (keys_exempt.has("*") and not strict) or (rescripted and _script_owned(obj, k)):
				continue
			if typeof(keys_exempt.get(k)) == TYPE_STRING:
				# Only the origin was set: the rest must be what the node had
				# without a stored value (its scenes' value, or the identity).
				if not _only_origin_differs(new_keys[k], _defined_value(ctx.get("root"), obj, k)):
					lost.append({"key": "%s|%s" % [after_id, k], "msg": "%s: '%s' would be added" % [label, k], "strict": false})
				continue
			if not strict and obj != null and _has_property(obj, k) and _converted(obj, obsolete, k):
				continue  # an obsolete property converted to its replacement
			if k == "layout_mode" and obj is Control:
				continue  # Godot works it out from the parent when a Control enters it
			if obj is Node:
				match _local_copy(new_keys[k], _defined_value(ctx.get("root"), obj, k), after, exempt, shares, _copy_scope(ctx.get("root"), obj)):
					1:
						continue  # Godot's own copy of a resource that is local to the scene
					2:
						lost.append({"key": "%s|%s" % [after_id, k], "msg": "%s: '%s' would change which values share a resource" % [label, k], "strict": strict})
						continue
					3:
						lost.append({"key": "%s|%s" % [after_id, k], "msg": "%s: '%s' is a copy of a resource local to the scene that is also copied for another scene in this file; which of those copies are shared depends on the Godot version and cannot be checked here (open and save the scene in the editor once)" % [label, k], "strict": strict})
						continue
			lost.append({"key": "%s|%s" % [after_id, k], "msg": "%s: '%s' would be added" % [label, k], "strict": strict})
	# Nodes that only the saved file defines must come from an action (project
	# code that adds nodes with an owner while the scene loads would otherwise
	# be saved). Override sections of inherited or instanced nodes are not new
	# nodes, but what one stores that the original did not must come from an
	# action too.
	var created := _created_paths(events)
	for id in after["sections"]:
		if id == "resource" or str(id).begins_with("sub:") or mapped.has(id):
			continue
		if not (after["headers"][id].has("type") or after["headers"][id].has("instance")):
			if _copy_ref(id, events).is_empty():
				lost.append_array(_gained_override(id, after, events, exempt, tree_changed, ctx.get("root"), shares))
			continue
		if created.any(func(c): return id == c[0] or (c[1] and id.begins_with(c[0] + "/"))):
			continue
		if _copy_of_saved(id, events):
			continue  # a copy of a saved node (compared with it below)
		lost.append({"key": "new|" + id, "msg": "node %s would be added" % id, "strict": false})
	lost.append_array(_duplicate_issues(after, events, ctx.get("root"), mapped, disturbed, placed))
	# Editable children (which instances show their own nodes for overrides).
	var toggled := {}
	for i in events.size():
		if events[i]["t"] in ["editable", "uneditable"]:
			var p := _forward(events[i]["path"], events, i + 1)
			if not p.is_empty():
				toggled[p] = true
	var kept := {}
	for p in before["editable"]:
		var now: String = _fate(p, events)["path"]
		if now.is_empty() or toggled.has(now) or _under_uneditable(now, events):
			continue
		kept[now] = true
		if not after["editable"].has(now):
			lost.append({"key": "editable|" + now, "msg": "node %s: its editable children would be turned off" % now, "strict": false})
	for p in after["editable"]:
		if kept.has(p) or toggled.has(p):
			continue
		var ref := _copy_ref(p, events)
		if not ref.is_empty() and after["editable"].has(ref["src"]):
			continue  # a copy keeps its source's
		if _inherited_editable(ctx.get("root")).has(p):
			continue  # Godot restating what the scene it inherits sets
		lost.append({"key": "editable+|" + p, "msg": "node %s: its editable children would be turned on" % p, "strict": false})
	# Sibling order decides drawing and processing order. Under a parent from
	# an inherited or instanced scene, a node's place among its siblings is
	# stored as index="n" (compared below); elsewhere it is the file order.
	var indexed := {}
	for id in after["order"]:
		if id != "." and after["headers"][id].has("index"):
			indexed[_parent_of(id)] = true
	for id in before["order"]:
		if id != "." and before["headers"][id].has("index"):
			indexed[_parent_of(_fate(id, events)["path"])] = true
	var after_order := {}
	for i in after["order"].size():
		after_order[after["order"][i]] = i
	var last := {}  # parent -> position in the saved file of the previous sibling
	for id in before["order"]:
		if not _defines_node(before, id):
			continue
		var fate := _fate(id, events)
		var path: String = fate["path"]
		if path.is_empty() or path == "." or not after_order.has(path):
			continue
		var parent := _parent_of(path)
		if indexed.has(parent) or placed.has(path):
			continue  # the others still keep their order
		if last.has(parent) and after_order[path] < last[parent]:
			lost.append({"key": "order|" + path, "msg": "node %s would move among its siblings" % path, "strict": false})
		last[parent] = after_order[path]
	# Godot appends the nodes a file adds in file order and moves each to its
	# index: compare the order both files produce, with the parent's other
	# children as they are now.
	var root_node: Node = ctx.get("root")
	if root_node != null:
		var mine_before_all := _added_children(before, events)
		var mine_after_all := _added_children(after, [])
		for parent in indexed:
			if str(parent).is_empty() or disturbed.has(parent) or created.any(func(c): return parent == c[0] or str(parent).begins_with(c[0] + "/")):
				continue
			var pn := root_node if parent == "." else root_node.get_node_or_null(NodePath(parent))
			if pn == null:
				continue
			var mine_before: Array = mine_before_all.get(parent, [])
			var mine_after: Array = mine_after_all.get(parent, [])
			var added_names := {}
			for a in mine_after:
				added_names[a[0]] = true
			var others := []
			for c in pn.get_children():
				if not added_names.has(str(c.name)):
					others.append(str(c.name))
			if _load_order(others, mine_before) != _load_order(others, mine_after):
				lost.append({"key": "order|" + parent, "msg": "children of %s would change order" % parent, "strict": false})
	var moved_connections := {}
	var used := {}  # disconnect events already matched to a connection
	for c in before["connections"]:
		var moved := _moved_connection(c, events, used)
		moved_connections[moved] = true
		if not moved.is_empty() and not after["connections"].has(moved):
			lost.append({"key": "conn|" + c, "msg": "connection %s would be dropped" % c, "strict": false})
	for c in after["connections"]:
		if moved_connections.has(c):
			continue
		var parts := str(c).split("|")
		var explained := false
		for i in events.size():
			var e: Dictionary = events[i]
			if e["t"] == "connect" and e["signal"] == parts[0] and e["method"] == parts[3] and _forward(e["from"], events, i + 1) == parts[1] and _forward(e["to"], events, i + 1) == parts[2]:
				explained = true
		if explained or created.any(func(c): return c[2] != "duplicate" and (parts[1] == c[0] or parts[2] == c[0] or (c[1] and (parts[1].begins_with(c[0] + "/") or parts[2].begins_with(c[0] + "/"))))):
			continue
		# A copy keeps its source's connections (with the ends that were copied
		# moved to the copy).
		# Godot copies the connections from a copied node; one to a node of the
		# same source goes to that node's copy.
		var copied := false
		var from_ref := _copy_ref(parts[1], events)
		if not from_ref.is_empty() and not str(from_ref["src"]).is_empty():
			var to_ref := _copy_ref(parts[2], events)
			var src_root := _forward(events[from_ref["i"]]["source"], events, from_ref["i"] + 1)
			if not to_ref.is_empty():
				copied = to_ref["i"] == from_ref["i"] and not str(to_ref["src"]).is_empty()
				parts[2] = to_ref["src"]
			else:
				copied = src_root.is_empty() or not _covers(src_root, parts[2])
			parts[1] = from_ref["src"]
		if not (copied and after["connections"].has("|".join(parts))):
			lost.append({"key": "conn+|" + c, "msg": "connection %s would be added" % c, "strict": false})
	return lost


## What an override section that the original did not have stores (for a
## node of an inherited or instanced scene, at saved-file path `id`) that no
## action explains: it must hold no value and no group of its own otherwise.
static func _gained_override(id: String, after: Dictionary, events: Array, exempt: Dictionary, tree_changed: bool, root: Node, shares: Dictionary) -> Array:
	var out := []
	var keys_exempt: Dictionary = exempt.get(id, {})
	var obj: Node = null
	if root != null:
		obj = root if id == "." else root.get_node_or_null(NodePath(id))
	var script = obj.get_script() if obj != null else null
	var script_vars := _script_vars(script) if script is Script else {}
	var rescripted := _final_rescripted(events).has(id)
	var label := _section_label(id)
	for k in after["sections"][id]:
		var v: String = after["sections"][id][k]
		var strict: bool = k == "script" or k.begins_with("metadata/") or script_vars.has(k)
		if _DERIVED_KEYS.has(k) or _is_full(keys_exempt.get(k)) or (keys_exempt.has("*") and not strict) or (rescripted and _script_owned(obj, k)):
			continue
		var defined = _defined_value(root, obj, k)
		if typeof(keys_exempt.get(k)) == TYPE_STRING:
			if _only_origin_differs(v, defined):
				continue  # only the origin was set
		elif k == "layout_mode" and obj is Control:
			continue
		elif defined != null and not (defined[0] is Object) and _same_text(v, defined[0]):
			continue  # Godot restating the value its scenes give the node
		else:
			match _local_copy(v, defined, after, exempt, shares, _copy_scope(root, obj)):
				1:
					continue  # Godot's own copy of a resource that is local to the scene
				2:
					out.append({"key": "%s|%s" % [id, k], "msg": "%s: '%s' would change which values share a resource" % [label, k], "strict": strict})
					continue
				3:
					out.append({"key": "%s|%s" % [id, k], "msg": "%s: '%s' is a copy of a resource local to the scene that is also copied for another scene in this file; which of those copies are shared depends on the Godot version and cannot be checked here (open and save the scene in the editor once)" % [label, k], "strict": strict})
					continue
		out.append({"key": "%s|%s" % [id, k], "msg": "%s: '%s' would be added" % [label, k], "strict": strict})
	if after["headers"][id].get("groups", "[]") != _expected_groups("[]", id, events):
		out.append({"key": "groups|" + id, "msg": "node %s: its groups would change" % id, "strict": false})
	return out


## The value that the scenes defining `node` (the scenes the edited one
## inherits, the scene of an instance it belongs to) store for `k`, as
## [value], or null when none does. Outer scenes override the scenes they
## instance.
static func _defined_value(root: Node, node: Node, k: String) -> Variant:
	if root == null or node == null:
		return null
	var out = null
	var anc := node
	while anc != null:
		if not anc.scene_file_path.is_empty():
			var ps = ResourceLoader.load(anc.scene_file_path, "PackedScene")
			var st: SceneState = (ps as PackedScene).get_state() if ps is PackedScene else null
			if anc == root and st != null:
				# The edited file itself is what is being compared (and its
				# paths are from before the batch's renames): only the scenes
				# it inherits define values here.
				st = st.get_base_scene_state()
			var rel := _norm(anc.get_path_to(node))
			var depth := 0
			var found := false
			while st != null and depth < 16 and not found:
				for n in st.get_node_count():
					if _norm(st.get_node_path(n)) != rel:
						continue
					for i in st.get_node_property_count(n):
						if st.get_node_property_name(n, i) == k:
							out = [st.get_node_property_value(n, i)]
							found = true
				st = st.get_base_scene_state()
				depth += 1
		if anc == root:
			break
		anc = anc.get_parent()
	return out


## Whether stored value `v` is the copy Godot makes of a resource local to
## the scene that `defined` (see _defined_value()) holds: 0 when it is not,
## 1 when it is, 2 when it is but it is shared differently from the original
## (see _pair()), 3 when it cannot be checked. Copies of one resource are accepted
## within one `scope` only (see _copy_scope()): across scenes, which nodes
## share a copy depends on the Godot version.
static func _local_copy(v: String, defined: Variant, after: Dictionary, exempt: Dictionary, shares: Dictionary, scope: String) -> int:
	if defined == null or not (defined[0] is Resource) or not (defined[0] as Resource).resource_local_to_scene:
		return 0
	if not _saves_local_copies():
		return 0  # Godot did not make this copy: project code replaced the value
	var pairs := []
	if not _same_local_copy(v, defined[0], after, exempt, pairs):
		return 0
	if shares["scope"].get(pairs[0][0], scope) != scope:
		return 3
	shares["scope"][pairs[0][0]] = scope
	for p in pairs:
		if not _pair(shares, p[0], p[1]):
			return 2
	return 1


## Whether this Godot version stores, in an inherited scene or for an
## instance, the copies it makes of resources local to the scene. Up to 4.7 it
## does on every save; from 4.8 it stores only values that are not its own
## copies, so a copy that a save gains is one that project code assigned.
static func _saves_local_copies() -> bool:
	var v := Engine.get_version_info()
	return int(v.get("major", 4)) == 4 and int(v.get("minor", 0)) < 8


## The scene a node's copies of resources local to a scene are made for, in
## every Godot version: its owner and the instance it belongs to.
static func _copy_scope(root: Node, node: Node) -> String:
	if root == null or node == null:
		return ""
	var inst := node
	while inst != root and inst.get_parent() != null and inst.scene_file_path.is_empty():
		inst = inst.get_parent()
	var own: Node = node.owner if node.owner != null else root
	return "%s|%s" % [_norm(root.get_path_to(own)), _norm(root.get_path_to(inst))]


## `exempt` with what it says of each saved sub-resource said of the original
## sub-resource paired with it (see _pair_refs()).
static func _exempt_for_original(exempt: Dictionary, shares: Dictionary) -> Dictionary:
	var out := exempt.duplicate()
	for l in shares["l"]:
		if str(l).begins_with("o:") and exempt.has("sub:" + str(shares["l"][l])):
			out["sub:" + str(l).trim_prefix("o:")] = exempt["sub:" + str(shares["l"][l])]
	return out


## Records that `l` (an original sub-resource "o:<id>", or the source of a
## copy "src:<file>::<id>") is saved as sub-resource `s`; false when either is
## already paired with another one.
static func _pair(shares: Dictionary, l: String, s: String) -> bool:
	if shares["l"].get(l, s) != s or shares["s"].get(s, l) != l:
		return false
	shares["l"][l] = s
	shares["s"][s] = l
	return true


## Pairs the sub-resources an original stored value and its saved value refer
## to (in order), and theirs in turn; false when that changes which values
## share one. Keys an action set are skipped.
static func _pair_refs(ov: String, nv: String, before: Dictionary, after: Dictionary, exempt: Dictionary, shares: Dictionary, depth: int = 0) -> bool:
	if not ov.contains("SubResource(") or depth > 8:
		return true
	var re := RegEx.create_from_string("SubResource\\(\"([^\"]+)\"\\)")
	var a := re.search_all(ov)
	var b := re.search_all(nv)
	if a.size() != b.size():
		return true  # (a different value: compared as a value)
	for i in a.size():
		var o := a[i].get_string(1)
		var sid := b[i].get_string(1)
		var known: bool = shares["l"].get("o:" + o) == sid
		if not _pair(shares, "o:" + o, sid):
			return false
		if known:
			continue
		var ok: Dictionary = before["sections"].get("sub:" + o, {})
		var nk: Dictionary = after["sections"].get("sub:" + sid, {})
		var skip: Dictionary = exempt.get("sub:" + sid, {})
		for k in ok:
			if nk.has(k) and not skip.has("*") and not _is_full(skip.get(k)) and not _pair_refs(ok[k], nk[k], before, after, exempt, shares, depth + 1):
				return false
	return true


## Paths (relative to the root) of instances whose children the scenes the
## edited one inherits make editable ([editable] lines of their .tscn files).
static func _inherited_editable(root: Node) -> Dictionary:
	var out := {}
	if root == null or root.scene_file_path.is_empty():
		return out
	var ps = ResourceLoader.load(root.scene_file_path, "PackedScene")
	var st: SceneState = (ps as PackedScene).get_state().get_base_scene_state() if ps is PackedScene else null
	var depth := 0
	while st != null and depth < 16:
		for p in _editable_lines(st.get_path()):
			out[p] = true
		st = st.get_base_scene_state()
		depth += 1
	# An instance restates the editable children its own scene file sets.
	var stack: Array = root.get_children()
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		stack.append_array(n.get_children())
		if not n.scene_file_path.is_empty():
			# (and those of the scenes that scene inherits)
			var at := _norm(root.get_path_to(n))
			var ips = ResourceLoader.load(n.scene_file_path, "PackedScene")
			var ist: SceneState = (ips as PackedScene).get_state() if ips is PackedScene else null
			var d := 0
			while ist != null and d < 16:
				for p in _editable_lines(ist.get_path()):
					out[at + "/" + p] = true
				ist = ist.get_base_scene_state()
				d += 1
	return out


## The [editable path] lines of a .tscn file (a binary scene cannot be read
## here: its lines are not known).
static func _editable_lines(path: String) -> Array:
	if path.get_extension() != "tscn":
		return []
	return (_file_sections(path)["editable"] as Dictionary).keys()


## Whether stored value text `v` (in `file`) is a SubResource holding the
## same values as `res` (a copy Godot makes of a resource local to a scene).
static func _same_local_copy(v: String, res: Resource, file: Dictionary, exempt: Dictionary, pairs: Array) -> bool:
	# Compared with the text of the file that defines the original, never with
	# live objects: project code may have changed those (a resource nested in
	# a local one is shared with the original).
	if not RegEx.create_from_string("^SubResource\\(\"[^\"]+\"\\)$").search(v):
		return false
	var path := res.resource_path
	var src_file := path.get_slice("::", 0)
	if path.is_empty() or not src_file.get_extension() in ["tscn", "tres"]:
		return false  # (no text to compare with: a binary or unsaved original)
	var src := _file_sections(src_file)
	var src_id := "__resource"
	if path.contains("::"):
		src_id = path.get_slice("::", 1)
	elif src["sections"].has("resource"):
		# A local resource saved in its own .tres file: compare with its [resource].
		src = src.duplicate(true)
		src["sections"]["sub:__resource"] = src["sections"]["resource"]
		src["headers"]["sub:__resource"] = {"type": res.get_class()}
	if not src["sections"].has("sub:" + src_id):
		return false
	var m := RegEx.create_from_string("^SubResource\\(\"([^\"]+)\"\\)$").search(v)
	return _same_sub("sub:" + m.get_string(1), file, "sub:" + src_id, src, 0, exempt, pairs, src_file)


## Whether sub-resource section `a_id` of file `a` stores the same as section
## `b_id` of file `b` (at `b_path`): same type; a key only one of them stores
## must hold its class default; nested sub-resources are compared the same
## way. Keys of `a` that `exempt` covers (an action set them) are skipped.
## Appends to `pairs` [source of each sub-resource of `b`, the one of `a`].
static func _same_sub(a_id: String, a: Dictionary, b_id: String, b: Dictionary, depth: int, exempt: Dictionary, pairs: Array, b_path: String) -> bool:
	if depth > 8 or not a["sections"].has(a_id) or not b["sections"].has(b_id):
		return false
	var type := str(a["headers"][a_id].get("type", ""))
	if type != str(b["headers"][b_id].get("type", "")):
		return false
	var ka: Dictionary = a["sections"][a_id]
	var kb: Dictionary = b["sections"][b_id]
	if ka.has("script") or kb.has("script"):
		return false  # (a script's defaults are not known here)
	var none := {"sections": {}}
	var sub := RegEx.create_from_string("^SubResource\\(\"([^\"]+)\"\\)$")
	var skip: Dictionary = exempt.get(a_id, {})
	pairs.append(["src:%s::%s" % [b_path, b_id.trim_prefix("sub:")], a_id.trim_prefix("sub:")])
	for k in ka.keys() + kb.keys():
		if skip.has("*") or _is_full(skip.get(k)):
			continue
		if ka.has(k) and kb.has(k):
			var ma := sub.search(ka[k])
			var mb := sub.search(kb[k])
			if ma != null and mb != null:
				if not _same_sub("sub:" + ma.get_string(1), a, "sub:" + mb.get_string(1), b, depth + 1, exempt, pairs, b_path):
					return false
			elif not _same_value_text(_canon(ka[k], a, none, {}), _canon(kb[k], b, none, {})):
				return false
			elif ka[k].contains("SubResource("):
				# Sub-resources in a collection: the same ones, in order.
				var ia := _SUB_REF.search_all(ka[k])
				var ib := _SUB_REF.search_all(kb[k])
				if ia.size() != ib.size():
					return false
				for i in ia.size():
					if not _same_sub("sub:" + ia[i].get_string(1), a, "sub:" + ib[i].get_string(1), b, depth + 1, exempt, pairs, b_path):
						return false
		else:
			# Stored on one side only: the other holds the class default.
			var only: String = ka[k] if ka.has(k) else kb[k]
			if not ClassDB.class_exists(type) or not _native_has(type, k) or only.contains("Resource("):
				return false
			if not _same_text(only, ClassDB.class_get_property_default_value(type, k)):
				return false
	return true


## The parsed text of a scene or resource file (cached for the operation).
static func _file_sections(path: String) -> Dictionary:
	if not _parsed_files.has(path):
		_parsed_files[path] = _sections(FileAccess.get_file_as_string(path))
	return _parsed_files[path]


## Whether stored transform text `v` differs from `defined` (as from
## _defined_value(); null: the identity) in its origin only.
static func _only_origin_differs(v: String, defined: Variant) -> bool:
	var t = str_to_var(v)
	var base = defined[0] if defined != null else null
	if t is Transform3D:
		return (t as Transform3D).basis.is_equal_approx(base.basis if base is Transform3D else Basis.IDENTITY)
	if t is Transform2D:
		var b: Transform2D = base if base is Transform2D else Transform2D.IDENTITY
		return (t as Transform2D).x.is_equal_approx(b.x) and (t as Transform2D).y.is_equal_approx(b.y)
	return false


## Whether `id` (a [node] section of the saved file) is a node that
## duplicate_node copied (_duplicate_issues() checks it against its source).
static func _copy_of_saved(id: String, events: Array) -> bool:
	return not _copy_ref(id, events).is_empty()


## A node that duplicate_node created, and each node copied with it, must
## store what its source stores (in the saved file), with the same groups,
## apart from keys actions set on the copy and the layout of a Control
## copied under another parent. A source that actions change or remove
## after it was copied is refused, since the copy can no longer be checked.
static func _duplicate_issues(after: Dictionary, events: Array, root: Node, mapped: Dictionary, disturbed: Dictionary, placed: Dictionary) -> Array:
	var out := []
	var none := {"sections": {}}  # compare sub-resources by content
	var set_keys := _set_keys_by_final(events)
	var rescripted := _final_rescripted(events)
	var changed := {}  # duplicate event -> _source_changed()
	var defined := _defined_paths(after)
	for i in events.size():
		if events[i]["t"] == "duplicate":
			changed[i] = _source_changed(events, i)
			if str(changed[i]["why"]).is_empty():
				var why := _uncheckable_source(defined, root, _forward(events[i]["source"], events, i + 1))
				if not why.is_empty():
					changed[i] = {"why": why, "keys": {}, "unsupported": true}
	for id in after["sections"]:
		if mapped.has(id) or id == "resource" or str(id).begins_with("sub:"):
			continue
		var ref := _copy_ref(id, events)
		if ref.is_empty():
			continue
		var i: int = ref["i"]
		if not str(changed[i]["why"]).is_empty():
			continue  # reported below
		var sid: String = ref["src"]
		var src_node: Node = root.get_node_or_null(NodePath(sid)) if root != null else null
		var dup_node: Node = root.get_node_or_null(NodePath(id)) if root != null else null
		if not after["sections"].has(sid):
			out.append({"key": "dup|" + id, "msg": "duplicate %s: its source %s is not saved" % [id, sid], "strict": false})
			continue
		var exempt: Dictionary = (set_keys.get(id, {}) as Dictionary).duplicate()
		if exempt.has("*"):
			continue
		exempt.merge(changed[i]["keys"])
		# A sub-path (`a:b`) exempts only that key of the sub-resource `a`
		# holds, in the copy and in its source (when they share it).
		var subex := {}
		var one_sub := RegEx.create_from_string("^SubResource\\(\"([^\"]+)\"\\)$")
		for k in exempt.keys():
			var parts := str(k).split(":")
			if parts.size() < 2:
				continue
			for sec in [after["sections"].get(sid, {}), after["sections"].get(id, {})]:
				var m := one_sub.search(str((sec as Dictionary).get(parts[0], "")))
				var j := 1
				while m != null and j < parts.size():
					var sub_id := "sub:" + m.get_string(1)
					if j == parts.size() - 1:
						(subex.get_or_add(sub_id, {}) as Dictionary)[parts[j]] = true
					m = one_sub.search(str((after["sections"].get(sub_id, {}) as Dictionary).get(parts[j], "")))
					j += 1
		if ref["root"] and _parent_of(events[i]["path"]) != _parent_of(events[i]["source"]) and dup_node is Control:
			exempt.merge(_LAYOUT_KEYS)
		var is_rescripted := rescripted.has(id)
		var src_header: Dictionary = after["headers"].get(sid, {})
		var header: Dictionary = after["headers"][id]
		if src_header.has("type") or src_header.has("instance"):
			for attr in ["type", "instance"]:
				if header.get(attr, "") != src_header.get(attr, ""):
					out.append({"key": "dup|" + id, "msg": "duplicate %s: its %s differs from %s" % [id, attr, sid], "strict": false})
		if header.get("groups", "[]") != _expected_groups(src_header.get("groups", "[]"), id, events):
			out.append({"key": "dupg|" + id, "msg": "duplicate %s: its groups differ from %s" % [id, sid], "strict": false})
		var a: Dictionary = after["sections"].get(sid, {})
		var b: Dictionary = after["sections"][id]
		var keys := a.keys()
		for k in b:
			if not a.has(k):
				keys.append(k)
		for k in keys:
			if exempt.has(k) or _DERIVED_KEYS.has(k) or (is_rescripted and _script_owned(dup_node, k)):
				continue
			var same := false
			if a.has(k) and b.has(k) and (header.get("node_paths", {}) as Dictionary).has(k):
				same = _copy_paths_match(a[k], b[k], sid, id, _forward(events[i]["source"], events, i + 1), events, i)
			elif a.has(k) and b.has(k):
				same = _same_value_text(_canon(a[k], after, none, subex), _canon(b[k], after, none, subex))
			elif b.has(k):
				same = _live_match(b[k], src_node, k, after, false)  # the source holds it without storing it
			else:
				same = _live_match(a[k], dup_node, k, after, true)  # the copy holds it as a default
			if not same:
				out.append({"key": "dup|%s|%s" % [id, k], "msg": "duplicate %s: '%s' differs from %s" % [id, k, sid], "strict": false})
	# The other way round: everything the source has (as the batch left it,
	# see _source_changed()) must be in the copy, in the same order.
	var after_order := {}
	for n in after["order"].size():
		after_order[after["order"][n]] = n
	for i in events.size():
		if events[i]["t"] != "duplicate":
			continue
		var s_at: String = events[i]["source"]
		var d_at: String = events[i]["path"]
		var copy := _forward(d_at, events, i + 1)
		if copy.is_empty():
			continue  # an action removed the copy
		if not after["sections"].has(copy):
			out.append({"key": "dupmiss|" + copy, "msg": "duplicate %s would be dropped" % copy, "strict": false})
			continue
		if changed[i].get("unsupported", false):
			out.append({"key": "dupsrc|%d" % i, "msg": "duplicate of %s: %s, which a headless edit cannot copy safely (use godot_editor)" % [s_at, changed[i]["why"]], "strict": false})
			continue
		if not str(changed[i]["why"]).is_empty():
			out.append({"key": "dupsrc|%d" % i, "msg": "duplicate of %s: the source was %s later in the same batch, so the copy cannot be checked (make that change in a separate call)" % [s_at, changed[i]["why"]], "strict": false})
			continue
		var src := _forward(s_at, events, i + 1)
		if src.is_empty():
			continue
		var last := {}  # parent in the copy -> position of the previous copied child
		for sid in after["order"]:
			if not _covers(src, sid) or sid == src:
				continue
			var then := _then(sid, events, i + 1)
			if then.is_empty() or not _covers(s_at, then):
				continue  # added under the source after the copy
			var expect := _forward(d_at + then.substr(s_at.length()), events, i + 1)
			if expect.is_empty():
				continue  # an action removed it from the copy
			if not after["sections"].has(expect):
				if _defines_node(after, sid) or after["headers"][sid].has("groups"):
					out.append({"key": "dupmiss|" + expect, "msg": "duplicate %s: %s (a copy of %s) would be dropped" % [_forward(d_at, events, i + 1), expect, sid], "strict": false})
				continue
			var parent := _parent_of(expect)
			if placed.has(expect) or not (after["headers"][sid].has("type") or after["headers"][sid].has("instance")):
				continue
			# Adding or removing siblings keeps the others' order.
			if last.has(parent) and after_order[expect] < last[parent]:
				out.append({"key": "duporder|" + expect, "msg": "duplicate %s: %s would move among its siblings" % [_forward(d_at, events, i + 1), expect], "strict": false})
			last[parent] = after_order[expect]
			if disturbed.has(parent) or disturbed.has(_parent_of(sid)):
				continue
			if after["headers"][sid].get("index", "") != after["headers"][expect].get("index", ""):
				out.append({"key": "duporder|" + expect, "msg": "duplicate %s: %s would move among its siblings" % [_forward(d_at, events, i + 1), expect], "strict": false})
		# Connections from the source's nodes are copied (Godot does not copy
		# connections that other nodes make to them).
		for c in after["connections"]:
			var parts := str(c).split("|")
			if not _covers(src, parts[1]):
				continue
			var ends := []
			for n in [1, 2]:
				var then := _then(parts[n], events, i + 1)
				if not _covers(src, parts[n]):
					ends.append(parts[n])
				elif then.is_empty() or not _covers(s_at, then):
					ends.append("")
				else:
					ends.append(_forward(d_at + then.substr(s_at.length()), events, i + 1))
			if ends.has(""):
				continue
			var disconnected := false  # from the copy, or connected to the source since
			for k in range(i + 1, events.size()):
				var e: Dictionary = events[k]
				if e["t"] in ["connect", "disconnect"] and e["signal"] == parts[0] and e["method"] == parts[3]:
					var ef := _forward(e["from"], events, k + 1)
					var et := _forward(e["to"], events, k + 1)
					if (e["t"] == "disconnect" and ef == ends[0] and et == ends[1]) or (e["t"] == "connect" and ef == parts[1] and et == parts[2]):
						disconnected = true
			parts[1] = ends[0]
			parts[2] = ends[1]
			if not disconnected and not after["connections"].has("|".join(parts)):
				out.append({"key": "dupconn|" + "|".join(parts), "msg": "duplicate %s: connection %s (a copy of %s) would be dropped" % [_forward(d_at, events, i + 1), "|".join(parts), c], "strict": false})
	return out


## A saved-file path `final` as it was right before event `from` ("" when an
## action at or after `from` created it).
static func _then(final: String, events: Array, from: int) -> String:
	var p := final
	for j in range(events.size() - 1, from - 1, -1):
		var e: Dictionary = events[j]
		match e["t"]:
			"rename":
				if e["old"] != "." and _covers(e["new"], p):
					p = e["old"] + p.substr(str(e["new"]).length())
			"remove", "new", "duplicate":
				if _covers(e["path"], p):
					return ""
	return p


## Whether stored value text `v` (of `file`) is what `node` holds in `k`
## (and, with `stored`, would store: a Container hides a child's rotation...).
static func _live_match(v: String, node: Node, k: String, file: Dictionary, stored: bool) -> bool:
	if node == null:
		return false
	if stored and not _stores(node, k):
		return false
	var cur = node.get(k)
	if cur is Resource:
		if _built_in(cur):
			return v.begins_with("SubResource(")
		return _canon(v, file, {"sections": {}}, {}) == "ExtResource(%s)" % (cur as Resource).resource_path
	return _same_text(_squash(v), cur)


## Per parent, the children that a file adds (sections with a type or an
## instance), in file order, as [name, index or -1]. With `events`, a file of
## the original is followed to the saved file's paths.
static func _added_children(file: Dictionary, events: Array) -> Dictionary:
	var out := {}
	for id in file["order"]:
		var h: Dictionary = file["headers"][id]
		if id == "." or not (h.has("type") or h.has("instance")):
			continue
		var path: String = _fate(id, events)["path"] if not events.is_empty() else id
		if not path.is_empty():
			(out.get_or_add(_parent_of(path), []) as Array).append([path.get_file(), int(h.get("index", "-1"))])
	return out


## Sibling order as Godot builds it when loading: `others` (children that
## come from the instanced or inherited scene), then each added child
## appended and moved to its index when it has one.
static func _load_order(others: Array, added: Array) -> Array:
	var order := others.duplicate()
	for a in added:
		order.append(a[0])
		if a[1] >= 0 and a[1] < order.size():
			order.erase(a[0])
			order.insert(a[1], a[0])
	return order


## Saved-file paths of nodes that actions created: [path, whether any node
## below it comes with it (an instance's children shown by editable
## children), the event type]. A duplicate's children must match its
## source's (see _copy_ref()).
static func _created_paths(events: Array) -> Array:
	var out := []
	for i in events.size():
		if events[i]["t"] in ["new", "duplicate", "editable"]:
			var path := _forward(events[i]["path"], events, i + 1)
			if not path.is_empty():
				out.append([path, events[i]["t"] == "editable", events[i]["t"]])
	return out


static func _stores(obj: Object, k: String) -> bool:
	for p in obj.get_property_list():
		if str(p["name"]) == k:
			return int(p["usage"]) & PROPERTY_USAGE_STORAGE != 0
	return false


static func _has_property(obj: Object, k: String) -> bool:
	for p in obj.get_property_list():
		if str(p["name"]) == k:
			return true
	return false


## Keys that actions set, per section of the saved file: properties set on
## nodes, properties edited on the main resource, and "a:b" paths into a
## sub-resource, which exempt key "b" of the sub-resource that "a" refers to.
static func _exemptions(before: Dictionary, after: Dictionary, events: Array, resource_keys: Dictionary) -> Dictionary:
	var out := {}
	var pending := []  # [section id in the saved file, key, true or "origin"]
	for k in resource_keys:
		pending.append(["resource", str(k), true])
	for i in events.size():
		if events[i]["t"] == "set":
			var path := _forward(events[i]["path"], events, i + 1)
			for k in events[i]["keys"]:
				pending.append([path, str(k), events[i]["keys"][k]])
	while not pending.is_empty():
		var item: Array = pending.pop_back()
		var id: String = item[0]
		var key: String = item[1]
		var section_exempt: Dictionary = out.get_or_add(id, {})
		if not _is_full(section_exempt.get(key)):
			section_exempt[key] = item[2]
		if not _is_full(item[2]):
			continue
		if key == "*":
			for v in (after["sections"].get(id, {}) as Dictionary).values():
				for m in RegEx.create_from_string("SubResource\\(\"([^\"]+)\"\\)").search_all(str(v)):
					if not out.get("sub:" + m.get_string(1), {}).has("*"):
						pending.append(["sub:" + m.get_string(1), "*", true])
			continue
		if not key.contains(":"):
			continue
		var head := key.get_slice(":", 0)
		# The head itself stays compared: it must still refer to the same
		# (paired) sub-resource, whose other keys must stay as they were.
		if not out[id].has(head):
			out[id][head] = _SUB_PATH
		var section: Dictionary = after["sections"].get(id, {})
		var m := RegEx.create_from_string("^SubResource\\(\"([^\"]+)\"\\)$").search(str(section.get(head, "")))
		if m != null:
			pending.append(["sub:" + m.get_string(1), key.substr(head.length() + 1), true])
	return out


static func _under_uneditable(path: String, events: Array) -> bool:
	for i in events.size():
		if events[i]["t"] == "uneditable":
			var p := _forward(events[i]["path"], events, i + 1)
			if path.begins_with(p + "/"):
				return true
	return false


## Whether a [node] section defines something of its own (a node, an instance,
## or stored values) rather than being an empty placeholder for an inherited node.
static func _defines_node(file: Dictionary, id: String) -> bool:
	var h: Dictionary = file["headers"][id]
	return h.has("type") or h.has("instance") or not (file["sections"][id] as Dictionary).is_empty()


## Why a stored key may have vanished from the saved section: "default" (the
## object holds the same value as a stored property), "obsolete" (not a
## property any more), or "" (lost).
static func _vanish(obj: Object, k: String, ov: String) -> String:
	if obj == null:
		return ""
	for p in obj.get_property_list():
		if str(p["name"]) == k:
			if int(p["usage"]) & PROPERTY_USAGE_STORAGE and _same_text(ov, obj.get(k)):
				return "default"
			return ""
	if k == "script" or k.begins_with("metadata/"):
		return ""
	var script = obj.get_script()
	if script is Script:
		for m in (script as Script).get_script_method_list():
			if str(m["name"]) == "_get_property_list":
				return ""  # it may have failed to accept the value
	return "obsolete"


## A node's groups (as _groups_of() writes them) after the batch's
## add_to_group/remove_from_group actions on it (`path` in the saved file).
static func _expected_groups(groups: String, path: String, events: Array) -> String:
	var names: Array = JSON.parse_string(groups)
	var changed := false
	for i in events.size():
		var e: Dictionary = events[i]
		if e["t"] == "group" and _forward(e["path"], events, i + 1) == path:
			changed = true
			if e["add"] and not names.has(e["group"]):
				names.append(e["group"])
			elif not e["add"]:
				names.erase(e["group"])
	if not changed:
		return groups
	names.sort()
	return JSON.stringify(names) if not names.is_empty() else "[]"


## Connection `c` of the original file in the saved file's paths ("" when an
## action removed one of its ends or disconnected it).
static func _moved_connection(c: String, events: Array, used: Dictionary) -> String:
	var parts := c.split("|")
	var from := parts[1]
	var to := parts[2]
	for i in events.size():
		var e: Dictionary = events[i]
		match e["t"]:
			"rename", "remove":
				from = _step(from, e)
				to = _step(to, e)
				if from.is_empty() or to.is_empty():
					return ""
			"disconnect":
				if not used.has(i) and e["signal"] == parts[0] and e["method"] == parts[3] and e["from"] == from and e["to"] == to:
					used[i] = true
					return ""
	return "%s|%s|%s|%s|%s" % [parts[0], from, to, parts[3], parts[4]]


## A stored value in comparable form: external resources by path, typed-
## collection wrappers removed, and sub-resources by id when `other` (the file
## it is compared with) has the same id (that section is compared on its own),
## otherwise by their (recursive) content minus exempted keys, so a copy under
## a new id compares equal.
static func _canon(v: String, file: Dictionary, other: Dictionary, exempt: Dictionary, depth: int = 0) -> String:
	# A StringName and a String with the same text mean the same here (older
	# files store `"key"` where Godot now writes `&"key"`).
	var out := _plain_names(_untyped(v))
	if out.contains("ExtResource("):
		for m in RegEx.create_from_string("ExtResource\\(\"([^\"]+)\"\\)").search_all(v):
			out = out.replace(m.get_string(), "ExtResource(%s)" % file["ext"].get(m.get_string(1), m.get_string(1)))
	if out.contains("SubResource(") and depth < 8:
		for m in RegEx.create_from_string("SubResource\\(\"([^\"]+)\"\\)").search_all(out):
			var id := "sub:" + m.get_string(1)
			if other["sections"].has(id):
				out = out.replace(m.get_string(), "Sub#" + m.get_string(1))
				continue
			var keys: Dictionary = file["sections"].get(id, {})
			var skip: Dictionary = exempt.get(id, {})
			var parts := [str(file["headers"].get(id, {}).get("type", ""))]
			var names := keys.keys()
			names.sort()
			for k in names:
				if not _is_full(skip.get(k)) and not skip.has("*"):
					parts.append("%s=%s" % [k, _canon(keys[k], file, other, exempt, depth + 1)])
			out = out.replace(m.get_string(), "Sub{%s}" % ";".join(parts))
	return out


## Value text with StringName literals (`&"a"`) written as String ones (`"a"`);
## an `&` inside a string is kept.
static func _plain_names(v: String) -> String:
	if not v.contains("&\""):
		return v
	var out := ""
	var in_str := false
	var i := 0
	while i < v.length():
		var c := v[i]
		if in_str:
			if c == "\\":
				out += v.substr(i, 2)
				i += 2
				continue
			if c == "\"":
				in_str = false
		elif c == "\"":
			in_str = true
		elif c == "&" and i + 1 < v.length() and v[i + 1] == "\"":
			i += 1
			continue
		out += c
		i += 1
	return out


static func _untyped(v: String) -> String:
	var m := RegEx.create_from_string("^(?:Array\\[[^\\]]*\\]\\((\\[.*\\])\\)|Dictionary\\[[^\\]]*\\]\\((\\{.*\\})\\))$").search(v)
	if m == null:
		return v
	return m.get_string(1) if not m.get_string(1).is_empty() else m.get_string(2)


## Whether two stored value texts mean the same value (formatting and key
## order may differ between Godot versions).
static func _same_value_text(a: String, b: String) -> bool:
	if a == b:
		return true
	if a.contains("Resource(") or b.contains("Resource(") or a.contains("Sub{") or b.contains("Sub{") or a.contains("Sub#") or b.contains("Sub#"):
		return false
	var va = str_to_var(a)
	var vb = str_to_var(b)
	if (va == null and a.strip_edges() != "null") or (vb == null and b.strip_edges() != "null"):
		return false  # (text that does not parse is never taken as equal)
	return _equivalent(va, vb)


static func _section_label(id: String) -> String:
	if id == "resource":
		return "resource"
	if id.begins_with("sub:"):
		return "sub-resource %s" % id.trim_prefix("sub:")
	return "node %s" % id


static func _native_has(cls: String, prop: String) -> bool:
	if not _native_props.has(cls):
		var names := {}
		for p in ClassDB.class_get_property_list(cls):
			names[str(p["name"])] = true
		_native_props[cls] = names
	return _native_props[cls].has(prop)


## Whether `cur` (what the object holds) is the stored value text `ov`.
static func _same_text(ov: String, cur: Variant) -> bool:
	if _squash(var_to_str(cur)) == ov:
		return true
	if ov.contains("Resource(") or ov.contains("Sub{") or ov.contains("Sub#"):
		return false
	return _equivalent(str_to_var(ov), cur)


## Sub-resources reachable from the saved object, by their id in the file.
static func _sub_resources(ctx: Dictionary) -> Dictionary:
	var out := {}
	var seen := {}
	var stack := []
	var root: Node = ctx.get("root")
	if ctx.get("main") != null:
		stack.append(ctx.get("main"))
	var state: SceneState = ctx.get("state")
	if state != null:
		for i in state.get_node_count():
			for j in state.get_node_property_count(i):
				stack.append(state.get_node_property_value(i, j))
	if root != null:
		stack.append(root)
		for n in root.find_children("*", "", true, false):
			if n.owner == root:
				stack.append(n)
	while not stack.is_empty() and seen.size() < 100000:
		var v = stack.pop_back()
		if v is Array:
			stack.append_array(v)
		elif v is Dictionary:
			stack.append_array((v as Dictionary).keys())
			stack.append_array((v as Dictionary).values())
		elif v is Object and is_instance_valid(v) and not seen.has(v.get_instance_id()):
			seen[v.get_instance_id()] = true
			if v is Script:
				continue
			if v is Resource:
				var rp := (v as Resource).resource_path
				if rp.contains("::"):
					out[rp.get_slice("::", 1)] = v
				elif not (v as Resource).resource_scene_unique_id.is_empty():
					out[(v as Resource).resource_scene_unique_id] = v
				if not rp.is_empty() and not rp.contains("::") and v != ctx.get("main"):
					continue  # an external resource: its sub-resources are not in this file
			for p in (v as Object).get_property_list():
				if int(p["usage"]) & PROPERTY_USAGE_STORAGE and int(p["type"]) in [TYPE_OBJECT, TYPE_ARRAY, TYPE_DICTIONARY]:
					stack.append((v as Object).get(p["name"]))
	return out


## Parse a .tscn/.tres into {"sections": {id: {key: value text}}, "headers":
## {id: {"type", "instance"}}, "ext": {ext_resource id: path}, "connections":
## {"signal|from|to|method": true}}. Section ids: "resource", "sub:<id>", or
## the node path ("." for the root). Value texts have whitespace outside
## strings removed.
static func _sections(text: String) -> Dictionary:
	var sections := {}
	var headers := {}
	var ext := {}
	var connections := {}
	var order := []  # node section ids in file order
	var editable := {}  # paths of instances with editable children
	var cur := ""
	var key := ""
	var val := ""
	var state := [0, false]  # bracket depth, inside a string
	for line in text.replace("\r\n", "\n").split("\n"):
		if state[0] <= 0 and not state[1]:
			if not key.is_empty():
				if not cur.is_empty():
					sections[cur][key] = _squash(val)
				key = ""
			if line.begins_with("[editable "):
				editable[_attr(line, "path")] = true
			if line.begins_with("["):
				cur = _section_id(line, ext)
				if line.begins_with("[connection "):
					# Flags, binds and unbinds belong to the connection too.
					var extra := []
					for attr in ["flags", "unbinds"]:
						var am := RegEx.create_from_string(" %s=(\\d+)" % attr).search(line)
						extra.append(am.get_string(1) if am != null else "")
					var bm := RegEx.create_from_string(" binds=(.*)\\]$").search(line)
					extra.append(_squash(bm.get_string(1)) if bm != null else "")
					connections["%s|%s|%s|%s|%s" % [_attr(line, "signal"), _attr(line, "from"), _attr(line, "to"), _attr(line, "method"), ",".join(extra)]] = true
				if not cur.is_empty() and not sections.has(cur):
					sections[cur] = {}
					var h := {}
					if line.contains(" type=\""):
						h["type"] = _attr(line, "type")
					var inst := RegEx.create_from_string(" instance=ExtResource\\(\"([^\"]+)\"\\)").search(line)
					if inst != null:
						h["instance"] = ext.get(inst.get_string(1), inst.get_string(1))
					var groups := _groups_of(line)
					if not groups.is_empty():
						h["groups"] = groups
					var index := _attr(line, "index")
					if not index.is_empty():
						h["index"] = index
					var np := RegEx.create_from_string(" node_paths=PackedStringArray\\(([^)]*)\\)").search(line)
					if np != null:
						var names := {}
						for m in RegEx.create_from_string("\"((?:[^\"\\\\]|\\\\.)*)\"").search_all(np.get_string(1)):
							names[m.get_string(1).c_unescape()] = true
						h["node_paths"] = names
					headers[cur] = h
					if line.begins_with("[node "):
						order.append(cur)
				continue
			var eq := line.find(" = ")
			if eq <= 0:
				continue
			key = line.substr(0, eq)
			if key.begins_with("\"") and key.ends_with("\""):
				key = key.substr(1, key.length() - 2).c_unescape()
			val = line.substr(eq + 3)
			state = _scan(val, [0, false])
		else:
			val += "\n" + line
			state = _scan(line, state)
	if not key.is_empty() and not cur.is_empty():
		sections[cur][key] = _squash(val)
	return {"sections": sections, "headers": headers, "ext": ext, "connections": connections, "order": order, "editable": editable}


## Track bracket depth and open strings across the lines of a value.
## The group names in a [node] header (sorted, as one comparable text).
static func _groups_of(header: String) -> String:
	var at := header.find(" groups=[")
	if at < 0:
		return ""
	var list := header.substr(at + 9)
	var end := 0  # just past the closing "]", skipping strings
	var in_str := false
	while end < list.length():
		var c := list[end]
		end += 1
		if in_str:
			if c == "\\":
				end += 1
			elif c == "\"":
				in_str = false
		elif c == "\"":
			in_str = true
		elif c == "]":
			break
	var names := []
	for m in RegEx.create_from_string("\"((?:[^\"\\\\]|\\\\.)*)\"").search_all(list.substr(0, end)):
		names.append(m.get_string(1).c_unescape())
	names.sort()
	return JSON.stringify(names) if not names.is_empty() else "[]"


static func _scan(s: String, state: Array) -> Array:
	var depth: int = state[0]
	var in_str: bool = state[1]
	if not in_str and not s.contains("\""):
		return [depth + s.count("(") + s.count("[") + s.count("{") - s.count(")") - s.count("]") - s.count("}"), false]
	var i := 0
	while i < s.length():
		var c := s[i]
		if in_str:
			if c == "\\":
				i += 1
			elif c == "\"":
				in_str = false
		elif c == "\"":
			in_str = true
		elif c in ["(", "[", "{"]:
			depth += 1
		elif c in [")", "]", "}"]:
			depth -= 1
		i += 1
	return [depth, in_str]


static func _section_id(header: String, ext: Dictionary) -> String:
	if header.begins_with("[resource]"):
		return "resource"
	if header.begins_with("[sub_resource "):
		return "sub:" + _attr(header, "id")
	if header.begins_with("[ext_resource "):
		ext[_attr(header, "id")] = _attr(header, "path")
		return ""
	if header.begins_with("[node "):
		var name := _attr(header, "name")
		if not header.contains(" parent=\""):
			return "."
		var parent := _attr(header, "parent")
		return name if parent == "." else parent + "/" + name
	return ""


static func _attr(header: String, attr: String) -> String:
	var m := RegEx.create_from_string(" %s=\"((?:[^\"\\\\]|\\\\.)*)\"" % attr).search(header)
	return m.get_string(1).c_unescape() if m != null else ""


## Scene text without what differs between two saves of the same scene to
## different paths (generated ext_resource ids, the file's own uid).
static func comparable(text: String) -> String:
	var ids := {}
	for m in RegEx.create_from_string("(?m)^\\[ext_resource [^\\n]*\\]$").search_all(text):
		ids[_attr(m.get_string(), "id")] = _attr(m.get_string(), "path")
	var out := RegEx.create_from_string("(?m)^(\\[gd_(?:scene|resource)[^\\n]*?) uid=\"[^\"]*\"").sub(text, "$1", true)
	out = RegEx.create_from_string("(?m)^(\\[ext_resource [^\\n]*?) id=\"[^\"]*\"").sub(out, "$1", true)
	for id in ids:
		out = out.replace("ExtResource(\"%s\")" % id, "ExtResource(%s)" % ids[id])
	return out


## Remove whitespace outside strings, so formatting differences do not count.
static func _squash(s: String) -> String:
	if not s.contains("\""):
		return _strip_ws(s)
	var parts := PackedStringArray()
	var start := 0
	var in_str := false
	var i := 0
	while i < s.length():
		var c := s[i]
		if in_str and c == "\\":
			i += 2
			continue
		if c == "\"":
			var chunk := s.substr(start, i + 1 - start)
			parts.append(chunk if in_str else _strip_ws(chunk))
			start = i + 1
			in_str = not in_str
		i += 1
	var rest := s.substr(start)
	parts.append(rest if in_str else _strip_ws(rest))
	return "".join(parts)


static func _strip_ws(s: String) -> String:
	return s.replace(" ", "").replace("\n", "").replace("\t", "").replace("\r", "")
