extends RefCounted
## Scene inspection (read-only, via SceneState) and batched scene editing.
##
## Inspection never instantiates nodes, so no project script runs.
## Editing instantiates the scene with GEN_EDIT_STATE_MAIN (the mode the editor
## uses), which preserves inherited scenes, instanced sub-scenes and their
## editable-children overrides. Attached scripts' _init() and property
## setters run during instantiation; _ready/_process never run because the
## scene is never added to a SceneTree.

const U = preload("../../addons/godot_mcp/lib/mcp_util.gd")
const C = preload("../../addons/godot_mcp/lib/variant_codec.gd")
const P = preload("../../addons/godot_mcp/lib/class_policy.gd")
const A = preload("scene_authoring.gd")
const PO = preload("project_ops.gd")


static func ops() -> Dictionary:
	return {
		"scene_inspect": scene_inspect,
		"node_inspect": node_inspect,
		"scene_create": scene_create,
		"scene_edit": scene_edit,
		"scene_save_as": scene_save_as,
	}


# ------------------------------------------------------------ helpers

static func load_scene(path_in: Variant) -> Variant:
	var path = U.to_res_path(path_in)
	if U.is_fail(path):
		return path
	if not path.get_extension().to_lower() in ["tscn", "scn"]:
		return U.fail("INVALID_ARGUMENT", "Not a scene file (.tscn/.scn): %s" % path)
	if not FileAccess.file_exists(path):
		return U.fail("NOT_FOUND", "Scene does not exist: %s" % path)
	U.register_uid(path)
	var ps = ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if ps == null or not (ps is PackedScene):
		return U.fail("OPERATION_FAILED", "Failed to load scene %s (see diagnostics)" % path)
	return ps


static func _norm_state_path(p: NodePath) -> String:
	var s := str(p)
	if s == ".":
		return "."
	if s.begins_with("./"):
		return s.substr(2)
	return s


static func _scene_root_type(ps: PackedScene, guard: int = 0) -> String:
	if ps == null or guard > 16:
		return ""
	var st := ps.get_state()
	if st.get_node_count() == 0:
		return ""
	var t := str(st.get_node_type(0))
	if not t.is_empty():
		return t
	var inst = st.get_node_instance(0)
	if inst is PackedScene:
		return _scene_root_type(inst, guard + 1)
	var base := st.get_base_scene_state()
	if base != null and base.get_node_count() > 0:
		var bt := str(base.get_node_type(0))
		if not bt.is_empty():
			return bt
		var binst = base.get_node_instance(0)
		if binst is PackedScene:
			return _scene_root_type(binst, guard + 1)
	return ""


static func _collect_state_paths(st: SceneState, out: Dictionary, guard: int = 0) -> void:
	if st == null or guard > 16:
		return
	for i in st.get_node_count():
		out[_norm_state_path(st.get_node_path(i))] = true
	_collect_state_paths(st.get_base_scene_state(), out, guard + 1)


## Paths of nodes that come from the base scene of an inherited scene.
static func inherited_paths(ps: PackedScene) -> Dictionary:
	var out := {}
	_collect_state_paths(ps.get_state().get_base_scene_state(), out)
	return out


# ------------------------------------------------------------ inspect

static func scene_inspect(args: Dictionary) -> Variant:
	var ps = load_scene(args.get("scene"))
	if U.is_fail(ps):
		return ps
	var st: SceneState = ps.get_state()
	var subtree := str(args.get("node", "")).trim_prefix("./")
	if subtree == "." or subtree == "root":
		subtree = ""
	var max_depth := int(args.get("max_depth", -1))
	var include_props := bool(args.get("include_properties", false))
	var offset := maxi(0, int(args.get("offset", 0)))
	var limit := clampi(int(args.get("limit", 200)), 1, 2000)
	var nodes := []
	var matched := 0
	for i in st.get_node_count():
		var path := _norm_state_path(st.get_node_path(i))
		if not subtree.is_empty() and path != subtree and not path.begins_with(subtree + "/"):
			continue
		var depth := 0 if path == "." else path.count("/") + 1
		if max_depth >= 0 and depth > max_depth:
			continue
		matched += 1
		if matched <= offset or nodes.size() >= limit:
			continue
		var entry := {"path": path, "name": str(st.get_node_name(i))}
		var t := str(st.get_node_type(i))
		var inst = st.get_node_instance(i)
		if inst is PackedScene:
			entry["instance"] = (inst as PackedScene).resource_path
			if t.is_empty():
				t = _scene_root_type(inst)
		elif t.is_empty():
			entry["override"] = true
		if i == 0 and st.get_base_scene_state() != null:
			entry["inherits"] = inst.resource_path if inst is PackedScene else ""
		entry["type"] = t
		var parent := _norm_state_path(st.get_node_path(i, true))
		if path != ".":
			entry["parent"] = parent
		var groups := st.get_node_groups(i)
		if not groups.is_empty():
			entry["groups"] = Array(groups)
		var props := {}
		for p in st.get_node_property_count(i):
			var pname := str(st.get_node_property_name(i, p))
			var pval = st.get_node_property_value(i, p)
			if pname == "script":
				entry["script"] = pval.resource_path if pval is Script else null
				continue
			if include_props:
				props[pname] = C.encode(pval, 1, 64)
		if include_props:
			entry["properties"] = props
		else:
			entry["property_count"] = st.get_node_property_count(i)
		if st.is_node_instance_placeholder(i):
			entry["placeholder"] = st.get_node_instance_placeholder(i)
		nodes.append(entry)
	var connections := []
	if bool(args.get("include_connections", true)):
		for c in st.get_connection_count():
			connections.append({
				"from": _norm_state_path(st.get_connection_source(c)),
				"signal": str(st.get_connection_signal(c)),
				"to": _norm_state_path(st.get_connection_target(c)),
				"method": str(st.get_connection_method(c)),
				"flags": st.get_connection_flags(c),
				"binds": C.encode(st.get_connection_binds(c), 1),
				"unbinds": st.get_connection_unbinds(c),
			})
	var base = st.get_base_scene_state()
	var res := {
		"scene": ps.resource_path if not ps.resource_path.is_empty() else str(args.get("scene")),
		"root_type": _scene_root_type(ps),
		"node_count": st.get_node_count(),
		"matched": matched,
		"offset": offset,
		"returned": nodes.size(),
		"has_more": offset + nodes.size() < matched,
		"nodes": nodes,
		"connections": connections,
		"dependencies": Array(ResourceLoader.get_dependencies(U.to_res_path(args.get("scene")))),
	}
	if base != null:
		res["inherited"] = true
	res["uid"] = U.uid_text(U.to_res_path(args.get("scene")))
	return res


static func node_inspect(args: Dictionary) -> Variant:
	var ps = load_scene(args.get("scene"))
	if U.is_fail(ps):
		return ps
	var st: SceneState = ps.get_state()
	var want := str(args.get("node", ".")).trim_prefix("./")
	if want.is_empty() or want == "root":
		want = "."
	if want.begins_with("root/"):
		want = want.substr(5)
	var idx := -1
	for i in st.get_node_count():
		if _norm_state_path(st.get_node_path(i)) == want:
			idx = i
			break
	if idx < 0:
		return U.fail("NOT_FOUND", "Node '%s' is not stored in %s (nodes inside instanced sub-scenes are only listed when overridden; inspect the sub-scene instead)" % [want, ps.resource_path])
	var t := str(st.get_node_type(idx))
	var inst = st.get_node_instance(idx)
	if t.is_empty() and inst is PackedScene:
		t = _scene_root_type(inst)
	var stored := {}
	var script_path = null
	for p in st.get_node_property_count(idx):
		var pname := str(st.get_node_property_name(idx, p))
		var pval = st.get_node_property_value(idx, p)
		if pname == "script":
			script_path = pval.resource_path if pval is Script else null
		else:
			stored[pname] = C.encode(pval, int(args.get("depth", 2)), 128)
	var out := {
		"path": want, "name": str(st.get_node_name(idx)), "type": t,
		"stored_properties": stored, "script": script_path,
		"groups": Array(st.get_node_groups(idx)),
	}
	if inst is PackedScene:
		out["instance"] = inst.resource_path
	if bool(args.get("include_class_properties", true)) and ClassDB.class_exists(t):
		var avail := []
		var filt := str(args.get("filter", "")).to_lower()
		for info in ClassDB.class_get_property_list(t):
			if not (int(info["usage"]) & PROPERTY_USAGE_EDITOR):
				continue
			var pn := str(info["name"])
			if not filt.is_empty() and not pn.to_lower().contains(filt):
				continue
			var e := {"name": pn, "type": type_string(int(info["type"]))}
			if int(info["hint"]) != PROPERTY_HINT_NONE and not str(info["hint_string"]).is_empty():
				e["hint_string"] = str(info["hint_string"]).left(200)
			if not str(info.get("class_name", "")).is_empty():
				e["class_name"] = str(info["class_name"])
			var def = ClassDB.class_get_property_default_value(t, pn)
			if def != null:
				e["default"] = C.encode(def, 0)
			avail.append(e)
		out["class_properties"] = avail
	if script_path != null and bool(args.get("include_script_properties", true)):
		var s = ResourceLoader.load(script_path, "Script")
		if s is Script:
			var sp := []
			for info in s.get_script_property_list():
				if int(info["usage"]) & PROPERTY_USAGE_EDITOR:
					sp.append({"name": info["name"], "type": type_string(int(info["type"])), "hint_string": str(info.get("hint_string", "")).left(200)})
			out["script_properties"] = sp
	var conns := []
	for c in st.get_connection_count():
		var src := _norm_state_path(st.get_connection_source(c))
		var dst := _norm_state_path(st.get_connection_target(c))
		if src == want or dst == want:
			conns.append({"from": src, "signal": str(st.get_connection_signal(c)), "to": dst, "method": str(st.get_connection_method(c))})
	out["connections"] = conns
	return out


# ------------------------------------------------------------ create / save

static func _pascal(s: String) -> String:
	var out := ""
	for part in s.get_basename().replace("-", "_").replace(" ", "_").split("_"):
		if not part.is_empty():
			out += part.substr(0, 1).to_upper() + part.substr(1)
	return out if not out.is_empty() and out.validate_node_name() == out else "Root"


static func save_packed(root: Node, path: String) -> Variant:
	var packed := PackedScene.new()
	var err := packed.pack(root)
	if err != OK:
		return U.godot_error(err, "PackedScene.pack")
	var dir_err := U.ensure_dir_for(path)
	if dir_err != OK:
		return U.godot_error(dir_err, "Creating directory for " + path)
	err = U.save_resource(packed, path)
	if err != OK:
		return U.godot_error(err, "ResourceSaver.save(%s)" % path)
	return verify_saved(path)


## Reload the saved file from disk (bypassing the cache) and confirm it is a
## valid, instantiable scene.
static func verify_saved(path: String) -> Variant:
	var reloaded = ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if reloaded == null or not (reloaded is PackedScene):
		return U.fail("OPERATION_FAILED", "Saved scene %s could not be reloaded" % path)
	if not (reloaded as PackedScene).can_instantiate():
		return U.fail("OPERATION_FAILED", "Saved scene %s cannot be instantiated" % path)
	return {"path": path, "node_count": (reloaded as PackedScene).get_state().get_node_count(), "uid": U.uid_text(path)}


static func scene_create(args: Dictionary) -> Variant:
	var path = U.to_res_path(args.get("scene"))
	if U.is_fail(path):
		return path
	if FileAccess.file_exists(path) and not bool(args.get("overwrite", false)):
		return U.fail("ALREADY_EXISTS", "Scene already exists: %s" % path)
	var root_name := str(args.get("root_name", ""))
	if root_name.is_empty():
		root_name = _pascal(path.get_file())
	if not U.valid_node_name(root_name):
		return U.fail("INVALID_ARGUMENT", "Invalid root node name '%s'" % root_name)
	var inherits = args.get("inherits")
	if inherits != null and str(inherits) != "":
		return _create_inherited(path, str(inherits), root_name)
	var root_type := str(args.get("root_type", "Node2D"))
	var root = P.create(root_type, "Node")
	if U.is_fail(root):
		return root
	root.name = root_name
	var props = args.get("properties", {})
	if typeof(props) == TYPE_DICTIONARY:
		for k in props.keys():
			var r = C.set_property(root, str(k), props[k], {"node": root, "root": root, "self_path": path})
			if U.is_fail(r):
				root.free()
				return r
	var saved = save_packed(root, path)
	root.free()
	if U.is_fail(saved):
		return saved
	saved["root_type"] = root_type
	saved["root_name"] = root_name
	return saved


## Inherited scenes cannot be created through the public API (packing a
## GEN_EDIT_STATE_MAIN_INHERITED instance flattens it), so the minimal
## documented .tscn header is written and Godot then loads, re-packs and
## re-saves it in canonical form.
static func _create_inherited(path: String, base_in: String, root_name: String) -> Variant:
	var base = U.to_res_path(base_in)
	if U.is_fail(base):
		return base
	if base == path:
		return U.fail("INVALID_ARGUMENT", "A scene cannot inherit itself")
	var base_ps = load_scene(base)
	if U.is_fail(base_ps):
		return base_ps
	var uid_attr := ""
	var uid := U.register_uid(base)
	if uid != ResourceUID.INVALID_ID:
		uid_attr = ' uid="%s"' % ResourceUID.id_to_text(uid)
	var text := '[gd_scene format=3]\n\n[ext_resource type="PackedScene"%s path="%s" id="1_base"]\n\n[node name="%s" instance=ExtResource("1_base")]\n' % [uid_attr, base, root_name.c_escape()]
	var dir_err := U.ensure_dir_for(path)
	if dir_err != OK:
		return U.godot_error(dir_err, "Creating directory for " + path)
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return U.godot_error(FileAccess.get_open_error(), "Writing " + path)
	f.store_string(text)
	f.close()
	var ps = load_scene(path)
	if U.is_fail(ps):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
		return ps
	var root: Node = ps.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
	var saved = save_packed(root, path)
	root.free()
	if U.is_fail(saved):
		return saved
	saved["inherits"] = base
	saved["root_type"] = _scene_root_type(base_ps)
	return saved


static func scene_save_as(args: Dictionary) -> Variant:
	var ps = load_scene(args.get("scene"))
	if U.is_fail(ps):
		return ps
	var target = U.to_res_path(args.get("new_path", args.get("scene")))
	if U.is_fail(target):
		return target
	if FileAccess.file_exists(target) and target != U.to_res_path(args.get("scene")) and not bool(args.get("overwrite", false)):
		return U.fail("ALREADY_EXISTS", "Target already exists: %s" % target)
	var root: Node = ps.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
	var saved = save_packed(root, target)
	root.free()
	return saved


# ------------------------------------------------------------ edit

static func scene_edit(args: Dictionary) -> Variant:
	var path = U.to_res_path(args.get("scene"))
	if U.is_fail(path):
		return path
	var ps = load_scene(path)
	if U.is_fail(ps):
		return ps
	var actions = args.get("actions", [])
	if typeof(actions) != TYPE_ARRAY or (actions as Array).is_empty():
		return U.fail("INVALID_ARGUMENT", "actions must be a non-empty array")
	var root: Node = ps.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
	if root == null:
		return U.fail("OPERATION_FAILED", "Scene %s could not be instantiated" % path)
	var ctx := {"root": root, "self_path": path, "inherited": inherited_paths(ps)}
	var results := []
	for i in (actions as Array).size():
		var a = actions[i]
		if typeof(a) != TYPE_DICTIONARY:
			root.free()
			return U.fail("INVALID_ARGUMENT", "actions[%d] must be an object" % i)
		var r = apply_action(root, a, ctx)
		if U.is_fail(r):
			root.free()
			var e: Dictionary = r[U.ERR_KEY]
			e["message"] = "actions[%d] (%s): %s" % [i, str(a.get("action", "?")), e["message"]]
			e["context"]["action_index"] = i
			e["context"]["note"] = "No changes were saved."
			return r
		results.append(r)
	var out := {"actions": results, "dry_run": bool(args.get("dry_run", false))}
	if not bool(args.get("dry_run", false)):
		var target = path
		if args.get("save_as") != null and str(args.get("save_as")) != "":
			target = U.to_res_path(args.get("save_as"))
			if U.is_fail(target):
				root.free()
				return target
		var saved = save_packed(root, target)
		if U.is_fail(saved):
			root.free()
			return saved
		out["saved"] = saved
	out["tree"] = summarize_tree(root, int(args.get("summary_depth", 2)))
	root.free()
	return out


static func summarize_tree(root: Node, max_depth: int) -> Array:
	var out := []
	_summ(root, root, 0, max_depth, out)
	return out


static func _summ(root: Node, n: Node, depth: int, max_depth: int, out: Array) -> void:
	if out.size() >= 300:
		return
	var e := {"path": U.rel_path(root, n), "type": n.get_class()}
	if not n.scene_file_path.is_empty() and n != root:
		e["instance"] = n.scene_file_path
	out.append(e)
	if depth >= max_depth:
		return
	if n != root and not n.scene_file_path.is_empty() and not root.is_editable_instance(n):
		return
	for c in n.get_children():
		_summ(root, c, depth + 1, max_depth, out)


static func _get_node(root: Node, a: Dictionary, key: String = "node") -> Variant:
	var p = a.get(key, a.get("node_path", a.get("path", ".")))
	var n := U.find_node(root, p)
	if n == null:
		return U.fail("NOT_FOUND", "Node not found: %s" % p, {"available": summarize_tree(root, 2).map(func(x): return x["path"])})
	return n


## "" if properties of `n` may be changed (the node is part of the edited
## scene, an instance root, or inside an instance with editable children).
static func editable_reason(root: Node, n: Node) -> String:
	if n == root or n.owner == root:
		return ""
	var inst := n.owner
	while inst != null and inst != root and inst.owner != root:
		inst = inst.owner
	if inst != null and inst != root and root.is_editable_instance(inst):
		return ""
	return "node '%s' belongs to an instanced sub-scene; enable editable children on its instance (set_editable_children) or edit the sub-scene file" % U.rel_path(root, n)


## "" if the node's structure (existence, name, parent) may be changed.
static func structural_reason(root: Node, n: Node, ctx: Dictionary) -> String:
	if n == root:
		return "the scene root cannot be removed, moved or renamed with this action"
	if n.owner != root:
		return "node '%s' belongs to an instanced sub-scene; its structure is defined by that scene" % U.rel_path(root, n)
	if (ctx.get("inherited", {}) as Dictionary).has(U.rel_path(root, n)):
		return "node '%s' is inherited from the base scene; change it in the base scene" % U.rel_path(root, n)
	return ""


static func _set_props(n: Node, props: Variant, ctx: Dictionary) -> Variant:
	if props == null:
		return {}
	if typeof(props) != TYPE_DICTIONARY:
		return U.fail("INVALID_ARGUMENT", "properties must be an object")
	var applied := {}
	var c := ctx.duplicate()
	c["node"] = n
	for k in (props as Dictionary).keys():
		var r = C.set_property(n, str(k), props[k], c)
		if U.is_fail(r):
			return r
		applied[str(k)] = r["value"]
	return applied


static func apply_action(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var kind := str(a.get("action", a.get("type", "")))
	match kind:
		"add_node": return _add_node(root, a, ctx)
		"remove_node": return _remove_node(root, a, ctx)
		"rename_node": return _rename_node(root, a, ctx)
		"move_node", "reparent_node": return _move_node(root, a, ctx)
		"reorder_node": return _reorder_node(root, a, ctx)
		"duplicate_node": return _duplicate_node(root, a, ctx)
		"instantiate_scene": return _instantiate_scene(root, a, ctx)
		"set_properties": return _set_properties(root, a, ctx)
		"attach_script": return _attach_script(root, a, ctx)
		"detach_script": return _detach_script(root, a, ctx)
		"connect_signal": return _connect_signal(root, a, ctx)
		"disconnect_signal": return _disconnect_signal(root, a, ctx)
		"add_to_group": return _group(root, a, ctx, true)
		"remove_from_group": return _group(root, a, ctx, false)
		"set_editable_children": return _set_editable(root, a, ctx)
	if A.handles(kind):
		return A.apply(root, kind, a, ctx)
	return U.fail("INVALID_ARGUMENT", "Unknown action '%s'" % kind)


static func _add_node(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var parent = _get_node(root, a, "parent")
	if U.is_fail(parent):
		return parent
	var why := editable_reason(root, parent)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	var name := str(a.get("name", ""))
	if not U.valid_node_name(name):
		return U.fail("INVALID_ARGUMENT", "Invalid node name '%s' (must not contain . : @ / \" %%)" % name)
	var type := str(a.get("type", a.get("node_type", "")))
	var existing := (parent as Node).get_node_or_null(NodePath(name))
	if existing != null:
		if str(a.get("if_exists", "error")) == "skip" and (existing.get_class() == type or existing.is_class(type)):
			return {"action": "add_node", "path": U.rel_path(root, existing), "skipped": true}
		return U.fail("CONFLICT", "'%s' already has a child named '%s'" % [U.rel_path(root, parent), name], {"hint": "use if_exists: \"skip\" for idempotent retries"})
	var n = P.create(type, "Node")
	if U.is_fail(n):
		return n
	n.name = name
	(parent as Node).add_child(n)
	n.owner = root
	if a.has("index"):
		(parent as Node).move_child(n, int(a["index"]))
	var applied = _set_props(n, a.get("properties"), ctx)
	if U.is_fail(applied):
		return applied
	return {"action": "add_node", "path": U.rel_path(root, n), "type": n.get_class(), "properties": applied}


static func _remove_node(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	var why := structural_reason(root, n, ctx)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	var path := U.rel_path(root, n)
	var removed := _count(n)
	n.get_parent().remove_child(n)
	n.free()
	return {"action": "remove_node", "path": path, "removed_nodes": removed}


static func _count(n: Node) -> int:
	var c := 1
	for ch in n.get_children():
		c += _count(ch)
	return c


static func _rename_node(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	var new_name := str(a.get("new_name", a.get("name", "")))
	if n != root:
		var why := structural_reason(root, n, ctx)
		if not why.is_empty():
			return U.fail("CONFLICT", why)
	if not U.valid_node_name(new_name):
		return U.fail("INVALID_ARGUMENT", "Invalid node name '%s'" % new_name)
	if n != root and n.get_parent().has_node(NodePath(new_name)) and n.get_parent().get_node(NodePath(new_name)) != n:
		return U.fail("CONFLICT", "A sibling named '%s' already exists" % new_name)
	var old := U.rel_path(root, n)
	n.name = new_name
	if str(n.name) != new_name:
		return U.fail("OPERATION_FAILED", "Godot renamed the node to '%s' instead of '%s'" % [n.name, new_name])
	return {"action": "rename_node", "old_path": old, "path": U.rel_path(root, n)}


static func _owned_descendants(root: Node, n: Node, out: Array) -> void:
	for c in n.get_children():
		if c.owner == root:
			out.append(c)
		_owned_descendants(root, c, out)


static func _global_xform(n: Node) -> Variant:
	if n is Node2D or n is Node3D:
		var x = n.transform
		var p := n.get_parent()
		while p != null:
			if (n is Node2D and p is Node2D) or (n is Node3D and p is Node3D):
				x = p.transform * x
			p = p.get_parent()
		return x
	return null


static func _move_node(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	var why := structural_reason(root, n, ctx)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	var np = _get_node(root, a, "new_parent")
	if U.is_fail(np):
		return np
	if np == n or (n as Node).is_ancestor_of(np):
		return U.fail("INVALID_ARGUMENT", "Cannot move a node under itself or its descendants")
	var pwhy := editable_reason(root, np)
	if not pwhy.is_empty():
		return U.fail("CONFLICT", pwhy)
	if (np as Node).has_node(NodePath(str(n.name))) and np != n.get_parent():
		return U.fail("CONFLICT", "'%s' already has a child named '%s'" % [U.rel_path(root, np), n.name])
	var keep := bool(a.get("keep_global_transform", false))
	var g = _global_xform(n) if keep else null
	var owned := []
	_owned_descendants(root, n, owned)
	var old := U.rel_path(root, n)
	n.get_parent().remove_child(n)
	(np as Node).add_child(n)
	n.owner = root
	for d in owned:
		d.owner = root
	if a.has("index"):
		(np as Node).move_child(n, int(a["index"]))
	if keep and g != null:
		var pg = _global_xform(np) if (np is Node2D or np is Node3D) else null
		n.transform = g if pg == null else pg.affine_inverse() * g
	return {"action": "move_node", "old_path": old, "path": U.rel_path(root, n)}


static func _reorder_node(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	var why := structural_reason(root, n, ctx)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	if not a.has("index"):
		return U.fail("INVALID_ARGUMENT", "index is required")
	n.get_parent().move_child(n, int(a["index"]))
	return {"action": "reorder_node", "path": U.rel_path(root, n), "index": n.get_index()}


static func _map_owners(root: Node, src: Node, dup: Node) -> void:
	# Mirror ownership from the original subtree onto the duplicate.
	for i in mini(src.get_child_count(), dup.get_child_count()):
		var s := src.get_child(i)
		var d := dup.get_child(i)
		if s.owner == root:
			d.owner = root
		_map_owners(root, s, d)


static func _duplicate_node(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	if n == root:
		return U.fail("INVALID_ARGUMENT", "The scene root cannot be duplicated")
	var why := editable_reason(root, n)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	var parent: Node = n.get_parent()
	if a.has("parent"):
		var p = _get_node(root, a, "parent")
		if U.is_fail(p):
			return p
		parent = p
	var dup: Node = n.duplicate()
	if a.has("new_name"):
		var nn := str(a["new_name"])
		if not U.valid_node_name(nn):
			dup.free()
			return U.fail("INVALID_ARGUMENT", "Invalid node name '%s'" % nn)
		if parent.has_node(NodePath(nn)):
			dup.free()
			return U.fail("CONFLICT", "A sibling named '%s' already exists" % nn)
		dup.name = nn
	parent.add_child(dup, true)
	dup.owner = root
	_map_owners(root, n, dup)
	return {"action": "duplicate_node", "source": U.rel_path(root, n), "path": U.rel_path(root, dup)}


static func _depends_on(scene_path: String, target: String, depth: int = 0, seen: Dictionary = {}) -> bool:
	if depth > 32 or seen.has(scene_path):
		return false
	seen[scene_path] = true
	for dep in ResourceLoader.get_dependencies(scene_path):
		var p := ""
		for part in str(dep).split("::"):
			if part.begins_with("res://"):
				p = part
		if p == target:
			return true
		if p.get_extension() in ["tscn", "scn"] and _depends_on(p, target, depth + 1, seen):
			return true
	return false


static func _instantiate_scene(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var parent = _get_node(root, a, "parent")
	if U.is_fail(parent):
		return parent
	var why := editable_reason(root, parent)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	var sp = U.to_res_path(a.get("scene"))
	if U.is_fail(sp):
		return sp
	if sp == ctx.get("self_path") or _depends_on(sp, ctx.get("self_path", "")):
		return U.fail("INVALID_ARGUMENT", "Instancing %s would create a cyclic scene dependency" % sp)
	var ps = load_scene(sp)
	if U.is_fail(ps):
		return ps
	var inst: Node = (ps as PackedScene).instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	if inst == null:
		return U.fail("OPERATION_FAILED", "Could not instantiate %s" % sp)
	var name := str(a.get("name", inst.name))
	if not U.valid_node_name(name):
		inst.free()
		return U.fail("INVALID_ARGUMENT", "Invalid node name '%s'" % name)
	if (parent as Node).has_node(NodePath(name)):
		var ex := (parent as Node).get_node(NodePath(name))
		if str(a.get("if_exists", "error")) == "skip" and ex.scene_file_path == sp:
			inst.free()
			return {"action": "instantiate_scene", "path": U.rel_path(root, ex), "skipped": true}
		inst.free()
		return U.fail("CONFLICT", "'%s' already has a child named '%s'" % [U.rel_path(root, parent), name])
	inst.name = name
	(parent as Node).add_child(inst)
	inst.owner = root
	if a.has("index"):
		(parent as Node).move_child(inst, int(a["index"]))
	var applied = _set_props(inst, a.get("properties"), ctx)
	if U.is_fail(applied):
		return applied
	return {"action": "instantiate_scene", "path": U.rel_path(root, inst), "scene": sp, "type": inst.get_class(), "properties": applied}


static func _set_properties(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	var why := editable_reason(root, n)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	var applied = _set_props(n, a.get("properties"), ctx)
	if U.is_fail(applied):
		return applied
	return {"action": "set_properties", "path": U.rel_path(root, n), "properties": applied}


static func _attach_script(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	var why := editable_reason(root, n)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	var sp = U.to_res_path(a.get("script"))
	if U.is_fail(sp):
		return sp
	if not sp.get_extension() in ["gd", "cs"]:
		return U.fail("INVALID_ARGUMENT", "Script must be a .gd or .cs file: %s" % sp)
	if not FileAccess.file_exists(sp):
		return U.fail("NOT_FOUND", "Script does not exist: %s" % sp)
	PO._take_logs()
	var s = ResourceLoader.load(sp, "Script")
	if s == null or not (s is Script):
		return U.fail("OPERATION_FAILED", "Script failed to load: %s (see diagnostics%s)" % [sp, "; C# requires the .NET build of Godot" if sp.ends_with(".cs") else ""])
	var base := str((s as Script).get_instance_base_type())
	if not base.is_empty() and not n.is_class(base):
		return U.fail("INVALID_ARGUMENT", "Script %s extends %s but node '%s' is a %s" % [sp, base, U.rel_path(root, n), n.get_class()])
	var note := ""
	var attach: Script = s
	if not (s as Script).can_instantiate():
		var names := []
		for al in PO.autoloads():
			names.append(al["name"])
		var diags := PO.classify_diagnostics(PO._take_logs(), names)
		var blocking := diags.filter(func(d): return d.get("severity") in ["error", "script_error"] and not str(d.get("message", "")).begins_with("Failed to load script"))
		if not blocking.is_empty() or diags.is_empty():
			return U.fail("OPERATION_FAILED", "Script %s has errors or is abstract and cannot be attached" % sp, {"diagnostics": blocking})
		# The analyzer accepted the script; only the compile step failed because
		# autoload singletons are not registered in the headless worker. Attach
		# it by reference through a compiled stand-in that owns the same path:
		# the saved scene references the real file, nothing of it executes.
		var stub := GDScript.new()
		stub.source_code = "extends %s\n" % (base if not base.is_empty() else n.get_class())
		if stub.reload() != OK:
			return U.fail("OPERATION_FAILED", "Could not prepare %s for attachment" % sp)
		stub.take_over_path(sp)
		attach = stub
		note = "The script uses autoload singletons, which cannot be compiled headlessly. It was attached by reference after Godot's analyzer accepted it; its exported properties and methods are not available to later actions in this batch."
	n.set_script(attach)
	if n.get_script() != attach:
		return U.fail("OPERATION_FAILED", "Godot refused to attach %s" % sp)
	var applied = _set_props(n, a.get("properties"), ctx)
	if U.is_fail(applied):
		return applied
	var out := {"action": "attach_script", "path": U.rel_path(root, n), "script": sp, "properties": applied}
	if not note.is_empty():
		out["note"] = note
	return out


static func _detach_script(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	var why := editable_reason(root, n)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	var had = n.get_script()
	n.set_script(null)
	return {"action": "detach_script", "path": U.rel_path(root, n), "removed": had.resource_path if had is Script else null}


static func _method_arity(target: Object, method: String) -> Variant:
	var lists := []
	var s = target.get_script()
	if s is Script:
		lists.append((s as Script).get_script_method_list())
	lists.append(target.get_method_list())
	for list in lists:
		for m in list:
			if str(m["name"]) == method:
				var total := (m["args"] as Array).size()
				var defaults := (m.get("default_args", []) as Array).size()
				var vararg := (int(m.get("flags", 0)) & METHOD_FLAG_VARARG) != 0
				return {"min": total - defaults, "max": -1 if vararg else total}
	return null


static func _signal_arity(source: Object, sig: String) -> int:
	for s in source.get_signal_list():
		if str(s["name"]) == sig:
			return (s["args"] as Array).size()
	return -1


static func _connect_signal(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var src = _get_node(root, a, "from")
	if U.is_fail(src):
		return src
	var dst = _get_node(root, a, "to")
	if U.is_fail(dst):
		return dst
	var sig := str(a.get("signal", ""))
	var method := str(a.get("method", ""))
	if not (src as Node).has_signal(sig):
		var names := []
		for s in (src as Node).get_signal_list():
			names.append(s["name"])
		return U.fail("NOT_FOUND", "%s has no signal '%s'" % [(src as Node).get_class(), sig], {"signals": names})
	if not method.is_valid_identifier():
		return U.fail("INVALID_ARGUMENT", "Invalid method name '%s'" % method)
	var binds := []
	if a.has("binds"):
		var b = C.decode(a["binds"], {"type": TYPE_ARRAY})
		if U.is_fail(b):
			return b
		binds = b
	var unbinds := int(a.get("unbinds", 0))
	var arity = _method_arity(dst, method)
	if arity == null:
		if not bool(a.get("allow_missing_method", false)):
			return U.fail("NOT_FOUND", "Target '%s' has no method '%s' (attach a script that defines it first, or pass allow_missing_method: true)" % [U.rel_path(root, dst), method])
	else:
		var passed := _signal_arity(src, sig) - unbinds + binds.size()
		if passed < int(arity["min"]) or (int(arity["max"]) >= 0 and passed > int(arity["max"])):
			return U.fail("INVALID_ARGUMENT", "Signal '%s' delivers %d argument(s) (after binds/unbinds) but '%s' accepts %s" % [sig, passed, method, ("%d" % arity["min"]) if arity["min"] == arity["max"] else ("%d..%s" % [arity["min"], "∞" if int(arity["max"]) < 0 else str(arity["max"])])])
	var callable := Callable(dst, method)
	if unbinds > 0:
		callable = callable.unbind(unbinds)
	if not binds.is_empty():
		callable = callable.bindv(binds)
	var flags := CONNECT_PERSIST
	if bool(a.get("deferred", false)):
		flags |= CONNECT_DEFERRED
	if bool(a.get("one_shot", false)):
		flags |= CONNECT_ONE_SHOT
	if (src as Node).is_connected(sig, callable):
		return {"action": "connect_signal", "already_connected": true}
	var err := (src as Node).connect(sig, callable, flags)
	if err != OK:
		return U.godot_error(err, "connect")
	return {"action": "connect_signal", "from": U.rel_path(root, src), "signal": sig, "to": U.rel_path(root, dst), "method": method}


static func _disconnect_signal(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var src = _get_node(root, a, "from")
	if U.is_fail(src):
		return src
	var dst = _get_node(root, a, "to")
	if U.is_fail(dst):
		return dst
	var sig := str(a.get("signal", ""))
	var method := str(a.get("method", ""))
	for c in (src as Node).get_signal_connection_list(sig):
		var cb: Callable = c["callable"]
		if cb.get_object() == dst and str(cb.get_method()) == method:
			(src as Node).disconnect(sig, cb)
			return {"action": "disconnect_signal", "from": U.rel_path(root, src), "signal": sig, "to": U.rel_path(root, dst), "method": method}
	return U.fail("NOT_FOUND", "No connection %s.%s -> %s.%s" % [U.rel_path(root, src), sig, U.rel_path(root, dst), method])


static func _group(root: Node, a: Dictionary, ctx: Dictionary, add: bool) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	var why := editable_reason(root, n)
	if not why.is_empty():
		return U.fail("CONFLICT", why)
	var g := str(a.get("group", ""))
	if g.strip_edges().is_empty():
		return U.fail("INVALID_ARGUMENT", "group is required")
	if add:
		(n as Node).add_to_group(g, true)
	else:
		if not (n as Node).is_in_group(g):
			return U.fail("NOT_FOUND", "Node is not in group '%s'" % g)
		(n as Node).remove_from_group(g)
	return {"action": "add_to_group" if add else "remove_from_group", "path": U.rel_path(root, n), "group": g}


static func _set_editable(root: Node, a: Dictionary, ctx: Dictionary) -> Variant:
	var n = _get_node(root, a)
	if U.is_fail(n):
		return n
	if n == root or (n as Node).scene_file_path.is_empty() or n.owner != root:
		return U.fail("INVALID_ARGUMENT", "set_editable_children applies to instanced sub-scene roots of this scene")
	root.set_editable_instance(n, bool(a.get("editable", true)))
	return {"action": "set_editable_children", "path": U.rel_path(root, n), "editable": root.is_editable_instance(n)}
