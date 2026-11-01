extends RefCounted
## GDScript diagnostics and reflection, using Godot's own parser/analyzer.
##
## Validation compiles each script with ResourceLoader (CACHE_MODE_IGNORE, so
## the shared cache is not polluted with broken scripts) and collects the
## errors Godot reports through the worker Logger. Note: loading a project
## script runs its `static var` initialisers and `_static_init()`; nothing
## else executes. Unsaved source from the caller is analysed but never
## compiled, so none of it runs (see script_validate_source).

const U = preload("../../addons/godot_mcp/lib/mcp_util.gd")
const C = preload("../../addons/godot_mcp/lib/variant_codec.gd")
const PO = preload("project_ops.gd")


static func ops() -> Dictionary:
	return {
		"script_validate": script_validate,
		"script_inspect": script_inspect,
		"script_validate_source": script_validate_source,
	}


static func _validate_one(path: String) -> Dictionary:
	PO._take_logs()
	var entry := {"path": path}
	if path.get_extension() == "cs":
		entry["skipped"] = "C# scripts are compiled by the .NET toolchain; use godot_dotnet_build"
		return entry
	var s = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	var diags := PO._take_logs()
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
	entry["valid"] = s != null and errors.is_empty()
	entry["loaded"] = s != null
	if not own.is_empty():
		entry["diagnostics"] = own
	if not deps.is_empty():
		entry["dependency_diagnostics"] = deps
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
	var results := []
	var invalid := 0
	for p in paths:
		var e := _validate_one(p)
		if not e.get("valid", true) and not e.has("skipped"):
			invalid += 1
		results.append(e)
	return {"checked": results.size(), "invalid": invalid, "valid": invalid == 0, "results": results}


## Validate unsaved source text (e.g. before writing it to disk).
##
## The source comes from the tool caller, so it must never run. GDScript runs
## `static var` initialisers and `_static_init()` as soon as a script compiles
## (GDScript::reload, whenever scripting is enabled, which it is in the
## worker). To get the analyzer's diagnostics without compiling, a sentinel
## constant with a guaranteed type error is appended on its own line: the
## analyzer still reports every error in the caller's code, but analysis can
## never succeed, so the compiler and the static initialisers never run.
## Anything that swallows the sentinel line (an open bracket, a trailing
## backslash, a dangling annotation) is itself a parse error, which also stops
## before compilation. Only errors on the sentinel line are filtered out.
## (The TypeScript side has already refused preload/extends paths outside the
## project, the only caller-chosen files the analyzer loads.)
static func script_validate_source(args: Dictionary) -> Variant:
	var source := str(args.get("source", ""))
	if source.length() > 2 * 1024 * 1024:
		return U.fail("INVALID_ARGUMENT", "Source too large")
	var label := str(args.get("path", "unsaved.gd"))
	# Unpredictable, so caller source can never declare or reference it.
	var sentinel_name := "__godot_mcp_no_compile_%s__" % Crypto.new().generate_random_bytes(12).hex_encode()
	# The sentinel lands on the line after the caller's last line.
	var sentinel_line := source.count("\n") + 2
	var last_code_line := _last_code_line(source)
	PO._take_logs()
	var g := GDScript.new()
	g.source_code = source + "\nconst %s: int = \"\"\n" % sentinel_name
	var err := g.reload()
	if err == OK:
		# Unreachable by construction (and static initialisers would already
		# have run by now); fail closed rather than report success.
		return U.fail("INTERNAL", "Source validation compiled unexpectedly; refusing to report a result")
	var logged := PO._take_logs()
	# The sentinel's type error names it; seeing it means the caller's code
	# parsed completely and analysis reached the end of the source.
	var sentinel_seen := logged.any(func(d): return str(d.get("message", "")).contains(sentinel_name))
	var diags := []
	for d in logged:
		var own := str(d.get("file", "")).begins_with("gdscript://")
		if own and int(d.get("line", 0)) >= sentinel_line:
			# Once analysis reached the sentinel, every error on its line is the
			# sentinel's own (Godot reports its type error twice). Otherwise the
			# caller's last construct ran into it: report that on the caller's line.
			if sentinel_seen:
				continue
			d["line"] = last_code_line
		if own:
			d["file"] = label
		diags.append(d)
	# Without the sentinel seen, a parse error has already been reported.
	var dangling := _dangling_warning_ignore(source) if sentinel_seen else 0
	if dangling > 0:
		diags.append({"severity": "error", "message": "Annotation \"@warning_ignore\" does not precede a valid target (nothing follows it)", "file": label, "line": dangling})
	var errors := diags.filter(func(d): return d.get("severity") in ["error", "script_error"] and str(d.get("file", "")) == label)
	var valid := sentinel_seen and errors.is_empty()
	var result := {"path": label, "valid": valid, "error": "" if valid else error_string(err), "diagnostics": diags}
	if not valid and errors.is_empty():
		result["error"] = "The source could not be analysed (no diagnostics were reported); check it with godot_script_write"
	return result


## 1-based number of the last line that holds code (not blank, not a comment).
static func _last_code_line(source: String) -> int:
	var lines := source.split("\n")
	for i in range(lines.size() - 1, -1, -1):
		var t := lines[i].strip_edges()
		if not t.is_empty() and not t.begins_with("#"):
			return i + 1
	return 1


## Line of a `@warning_ignore(...)` that ends the source with nothing after it
## (0 if none). Every other annotation without a target is either standalone
## (@export_group, @warning_ignore_restore, ...) or refused by Godot when it
## lands on the sentinel constant; @warning_ignore alone would silently attach
## to the sentinel and hide the "does not precede a valid target" error.
## Handles arguments split over several lines and `stmt; @warning_ignore(...)`.
static func _dangling_warning_ignore(source: String) -> int:
	var lines := source.split("\n")
	var end := lines.size()
	while end > 0:
		var t := lines[end - 1].strip_edges()
		if not t.is_empty() and not t.begins_with("#"):
			break
		end -= 1
	if end == 0:
		return 0
	var tail := "\n".join(lines.slice(0, end))
	# Must start a line or follow `;` (not inside a trailing comment); `\`
	# continuations may sit between the name and its arguments.
	var m := RegEx.create_from_string("(?:^|\\n|;)[ \\t]*(@warning_ignore)(?:\\s|\\\\\\r?\\n)*(\\([^()]*\\))?[ \\t]*(#[^\\n]*)?\\s*$").search(tail)
	if m == null:
		return 0
	var line := tail.substr(0, m.get_start(1)).count("\n") + 1
	# A script that is nothing but leading annotations is valid (class-level).
	for i in line - 1:
		var t := lines[i].strip_edges()
		if not t.is_empty() and not t.begins_with("#") and not t.begins_with("@"):
			return line
	return 0


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
