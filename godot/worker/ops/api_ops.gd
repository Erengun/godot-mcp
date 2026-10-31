extends RefCounted
## Engine API discovery via ClassDB (runtime reflection of the running Godot
## build) plus the project's global script classes.

const U = preload("../../addons/godot_mcp/lib/mcp_util.gd")
const C = preload("../../addons/godot_mcp/lib/variant_codec.gd")
const P = preload("../../addons/godot_mcp/lib/class_policy.gd")


static func ops() -> Dictionary:
	return {"api_search": api_search, "api_class": api_class}


static func _kind(cls: String) -> String:
	if cls == "Node" or ClassDB.is_parent_class(cls, "Node"):
		return "node"
	if cls == "Resource" or ClassDB.is_parent_class(cls, "Resource"):
		return "resource"
	return "object"


static func api_search(args: Dictionary) -> Variant:
	var q := str(args.get("query", "")).to_lower()
	var kind := str(args.get("kind", "any"))
	var inherits := str(args.get("inherits", ""))
	var limit := clampi(int(args.get("limit", 50)), 1, 500)
	var include_editor := bool(args.get("include_editor", false))
	var hits := []
	var total := 0
	var names := Array(ClassDB.get_class_list())
	names.sort()
	for cls in names:
		var c := str(cls)
		if not q.is_empty() and not c.to_lower().contains(q):
			continue
		if not include_editor and ClassDB.class_get_api_type(c) in [ClassDB.API_EDITOR, ClassDB.API_EDITOR_EXTENSION]:
			continue
		var k := _kind(c)
		if kind != "any" and k != kind:
			continue
		if not inherits.is_empty() and c != inherits and not ClassDB.is_parent_class(c, inherits):
			continue
		total += 1
		if hits.size() < limit:
			hits.append({"class": c, "inherits": str(ClassDB.get_parent_class(c)), "kind": k, "instantiable": ClassDB.can_instantiate(c), "creatable_via_mcp": P.check(c, "Node" if k == "node" else "Resource").is_empty() if k != "object" else false})
	for g in ProjectSettings.get_global_class_list():
		var gc := str(g.get("class", ""))
		if not q.is_empty() and not gc.to_lower().contains(q):
			continue
		var native := P.global_class_native_base(gc)
		var gk := _kind(native) if not native.is_empty() else "object"
		if kind != "any" and gk != kind:
			continue
		total += 1
		if hits.size() < limit:
			hits.append({"class": gc, "inherits": str(g.get("base", "")), "kind": gk, "project_class": true, "path": g.get("path", "")})
	return {"total": total, "returned": hits.size(), "classes": hits}


static func api_class(args: Dictionary) -> Variant:
	var cls := str(args.get("class", ""))
	var filter := str(args.get("filter", "")).to_lower()
	var inherited := bool(args.get("include_inherited", false))
	var sections: Array = args.get("sections", ["properties", "methods", "signals", "enums", "constants"])
	if not ClassDB.class_exists(cls):
		var g := P.find_global_class(cls)
		if g.is_empty():
			return U.fail("NOT_FOUND", "Unknown class '%s'" % cls)
		return _script_class(g, filter)
	var chain := []
	var p := cls
	while not p.is_empty():
		chain.append(p)
		p = str(ClassDB.get_parent_class(p))
	var out := {"class": cls, "inheritance": chain, "kind": _kind(cls), "instantiable": ClassDB.can_instantiate(cls), "api": ["core", "editor", "extension", "editor_extension", "none"][ClassDB.class_get_api_type(cls)] if ClassDB.class_get_api_type(cls) < 5 else "unknown"}
	if _kind(cls) != "object":
		out["creatable_via_mcp"] = P.check(cls, "Node" if _kind(cls) == "node" else "Resource").is_empty()
	if "properties" in sections:
		var props := []
		for info in ClassDB.class_get_property_list(cls, not inherited):
			var usage := int(info["usage"])
			if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
				continue
			var n := str(info["name"])
			if not filter.is_empty() and not n.to_lower().contains(filter):
				continue
			var e := {"name": n, "type": type_string(int(info["type"])), "editor": (usage & PROPERTY_USAGE_EDITOR) != 0, "stored": (usage & PROPERTY_USAGE_STORAGE) != 0}
			if not str(info.get("class_name", "")).is_empty():
				e["class_name"] = str(info["class_name"])
			if int(info["hint"]) != PROPERTY_HINT_NONE:
				e["hint"] = int(info["hint"])
				e["hint_string"] = str(info["hint_string"]).left(300)
			var def = ClassDB.class_get_property_default_value(cls, n)
			if def != null:
				e["default"] = C.encode(def, 0)
			props.append(e)
		out["properties"] = props
	if "methods" in sections:
		var methods := []
		for m in ClassDB.class_get_method_list(cls, not inherited):
			var n := str(m["name"])
			if n.begins_with("_") and not bool(args.get("include_virtual", false)):
				continue
			if not filter.is_empty() and not n.to_lower().contains(filter):
				continue
			var margs := []
			for a in m.get("args", []):
				margs.append({"name": a["name"], "type": type_string(int(a["type"])), "class_name": str(a.get("class_name", ""))})
			methods.append({"name": n, "args": margs, "default_count": (m.get("default_args", []) as Array).size(), "return": type_string(int(m.get("return", {}).get("type", TYPE_NIL))), "flags": int(m.get("flags", 0))})
		out["methods"] = methods
	if "signals" in sections:
		var sigs := []
		for s in ClassDB.class_get_signal_list(cls, not inherited):
			if not filter.is_empty() and not str(s["name"]).to_lower().contains(filter):
				continue
			var sargs := []
			for a in s.get("args", []):
				sargs.append({"name": a["name"], "type": type_string(int(a["type"]))})
			sigs.append({"name": s["name"], "args": sargs})
		out["signals"] = sigs
	if "enums" in sections:
		var enums := {}
		for en in ClassDB.class_get_enum_list(cls, not inherited):
			var vals := {}
			for k in ClassDB.class_get_enum_constants(cls, en, not inherited):
				vals[k] = ClassDB.class_get_integer_constant(cls, k)
			enums[en] = vals
		out["enums"] = enums
	if "constants" in sections:
		var consts := {}
		for k in ClassDB.class_get_integer_constant_list(cls, not inherited):
			if ClassDB.class_get_integer_constant_enum(cls, k, not inherited).is_empty():
				consts[k] = ClassDB.class_get_integer_constant(cls, k)
		out["constants"] = consts
	return out


static func _script_class(g: Dictionary, filter: String) -> Variant:
	var s = ResourceLoader.load(str(g.get("path", "")), "Script")
	if not (s is Script):
		return U.fail("OPERATION_FAILED", "Project class '%s' failed to load" % g.get("class"))
	var props := []
	for p in (s as Script).get_script_property_list():
		if filter.is_empty() or str(p["name"]).to_lower().contains(filter):
			props.append({"name": p["name"], "type": type_string(int(p["type"])), "exported": (int(p["usage"]) & PROPERTY_USAGE_EDITOR) != 0})
	var methods := []
	for m in (s as Script).get_script_method_list():
		if filter.is_empty() or str(m["name"]).to_lower().contains(filter):
			methods.append({"name": m["name"], "arg_count": (m.get("args", []) as Array).size()})
	var sigs := []
	for sg in (s as Script).get_script_signal_list():
		sigs.append({"name": sg["name"], "arg_count": (sg.get("args", []) as Array).size()})
	return {"class": g.get("class"), "project_class": true, "path": g.get("path"), "base": g.get("base"), "native_base": P.global_class_native_base(str(g.get("class"))), "properties": props, "methods": methods, "signals": sigs}
