extends RefCounted
## GDScript diagnostics and reflection, using Godot's own parser/analyzer.
##
## Validation compiles each script with ResourceLoader (CACHE_MODE_IGNORE, so
## the shared cache is not polluted with broken scripts) and collects the
## errors Godot reports through the worker Logger. Note: loading a script runs
## its `static var` initialisers and `_static_init()`; nothing else executes.

const U = preload("../../addons/godot_mcp/lib/mcp_util.gd")
const C = preload("../../addons/godot_mcp/lib/variant_codec.gd")
const PO = preload("project_ops.gd")


static func ops() -> Dictionary:
	return {
		"script_validate": script_validate,
		"script_inspect": script_inspect,
		"script_validate_source": script_validate_source,
	}


static func _autoload_names() -> Array:
	var names := []
	for a in PO.autoloads():
		names.append(a["name"])
	return names


static func _validate_one(path: String, autoloads: Array) -> Dictionary:
	PO._take_logs()
	var entry := {"path": path}
	if path.get_extension() == "cs":
		entry["skipped"] = "C# scripts are compiled by the .NET toolchain; use godot_dotnet_build"
		return entry
	var s = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	var diags := PO.classify_diagnostics(PO._take_logs(), autoloads)
	var own := []
	var deps := []
	for d in diags:
		var f := str(d.get("file", ""))
		if f == path or f.begins_with("gdscript://"):
			own.append(d)
		elif f.begins_with("res://"):
			deps.append(d)
		elif str(d.get("message", "")).contains(path):
			# "Failed to load script ..." engine summary lines
			d["severity"] = "info" if not own.is_empty() else d.get("severity")
			own.append(d)
	var errors := own.filter(func(d): return d.get("severity") in ["error", "script_error"])
	var autoload_only := errors.is_empty() and own.any(func(d): return d.has("note"))
	entry["valid"] = s != null and errors.is_empty() or autoload_only
	entry["loaded"] = s != null
	if not own.is_empty():
		entry["diagnostics"] = own
	if not deps.is_empty():
		entry["dependency_diagnostics"] = deps
	if autoload_only:
		entry["partial"] = "Compilation stopped at an autoload reference; later errors (if any) were not checked headlessly."
	if s is Script:
		entry["class_name"] = str((s as Script).get_global_name())
		entry["extends"] = str((s as Script).get_instance_base_type())
	return entry


static func script_validate(args: Dictionary) -> Variant:
	var paths := []
	if bool(args.get("all", false)):
		PO.collect_files("res://", ["gd"], bool(args.get("include_addons", false)), paths, clampi(int(args.get("max_files", 2000)), 1, 20000))
	for p in args.get("paths", []):
		var rp = U.to_res_path(p)
		if U.is_fail(rp):
			return rp
		if not FileAccess.file_exists(rp):
			return U.fail("NOT_FOUND", "Script does not exist: %s" % rp)
		if not rp in paths:
			paths.append(rp)
	if paths.is_empty():
		return U.fail("INVALID_ARGUMENT", "Pass paths or all: true")
	var autoloads := _autoload_names()
	var results := []
	var invalid := 0
	for p in paths:
		var e := _validate_one(p, autoloads)
		if not e.get("valid", true) and not e.has("skipped"):
			invalid += 1
		results.append(e)
	return {"checked": results.size(), "invalid": invalid, "valid": invalid == 0, "results": results}


## Validate unsaved source text (e.g. before writing it to disk).
static func script_validate_source(args: Dictionary) -> Variant:
	var source := str(args.get("source", ""))
	if source.length() > 2 * 1024 * 1024:
		return U.fail("INVALID_ARGUMENT", "Source too large")
	var label := str(args.get("path", "unsaved.gd"))
	PO._take_logs()
	var g := GDScript.new()
	g.source_code = source
	var err := g.reload()
	var diags := PO.classify_diagnostics(PO._take_logs(), _autoload_names())
	for d in diags:
		if str(d.get("file", "")).begins_with("gdscript://"):
			d["file"] = label
	var errors := diags.filter(func(d): return d.get("severity") in ["error", "script_error"] and str(d.get("file", "")) == label)
	return {"path": label, "valid": err == OK and errors.is_empty(), "error": error_string(err) if err != OK else "", "diagnostics": diags}


static func _arg_desc(a: Dictionary) -> Dictionary:
	var d := {"name": a.get("name", ""), "type": type_string(int(a.get("type", TYPE_NIL)))}
	if not str(a.get("class_name", "")).is_empty():
		d["class_name"] = str(a["class_name"])
	return d


static func script_inspect(args: Dictionary) -> Variant:
	var path = U.to_res_path(args.get("path"))
	if U.is_fail(path):
		return path
	if not FileAccess.file_exists(path):
		return U.fail("NOT_FOUND", "Script does not exist: %s" % path)
	var source := FileAccess.get_file_as_string(path)
	var s = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not (s is Script):
		return U.fail("OPERATION_FAILED", "%s could not be loaded as a script (see diagnostics; run godot_script_validate)" % path)
	var sc := s as Script
	var methods := []
	for m in sc.get_script_method_list():
		var margs := []
		for a in m.get("args", []):
			margs.append(_arg_desc(a))
		var defaults := (m.get("default_args", []) as Array).size()
		methods.append({
			"name": m["name"], "args": margs, "required_args": margs.size() - defaults,
			"return": _arg_desc(m.get("return", {})), "static": (int(m.get("flags", 0)) & METHOD_FLAG_STATIC) != 0,
		})
	var props := []
	for p in sc.get_script_property_list():
		var usage := int(p.get("usage", 0))
		if usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP or usage & PROPERTY_USAGE_SUBGROUP:
			continue
		props.append({"name": p["name"], "type": type_string(int(p["type"])), "exported": (usage & PROPERTY_USAGE_EDITOR) != 0, "hint_string": str(p.get("hint_string", "")).left(160)})
	var signals := []
	for sg in sc.get_script_signal_list():
		var sargs := []
		for a in sg.get("args", []):
			sargs.append(_arg_desc(a))
		signals.append({"name": sg["name"], "args": sargs})
	var consts := {}
	var cmap := sc.get_script_constant_map()
	for k in cmap.keys():
		var v = cmap[k]
		consts[k] = C.encode(v, 0) if typeof(v) != TYPE_OBJECT else {"$type": "Object", "class": v.get_class() if v != null else "null"}
	var base = sc.get_base_script()
	return {
		"path": path,
		"class_name": str(sc.get_global_name()),
		"extends": str(sc.get_instance_base_type()),
		"base_script": base.resource_path if base is Script else null,
		"is_tool": sc.is_tool(),
		"can_instantiate": sc.can_instantiate(),
		"methods": methods,
		"properties": props,
		"signals": signals,
		"constants": consts,
		"line_count": source.count("\n") + 1,
		"dependencies": Array(ResourceLoader.get_dependencies(path)),
	}
