extends RefCounted
## Project metadata, settings, InputMap, autoloads and project-wide validation.

const U = preload("../../addons/godot_mcp/lib/mcp_util.gd")
const C = preload("../../addons/godot_mcp/lib/variant_codec.gd")

## Settings that may be written through project_settings_set.
const ALLOWED_PREFIXES := [
	"application/config/", "application/boot_splash/", "application/run/main_scene",
	"display/", "rendering/", "physics/", "layer_names/", "gui/", "audio/",
	"input_devices/", "navigation/", "internationalization/", "animation/",
	"debug/settings/", "debug/gdscript/", "debug/shapes/", "xr/",
]
## Settings that are never writable here (code execution, file redirection, editor state).
const DENIED_PREFIXES := [
	"autoload/", "editor_plugins/", "editor/", "dotnet/", "input/", "filesystem/",
	"application/run/main_loop_type", "application/config/project_settings_override",
	"debug/file_logging/", "application/config/custom_user_dir_name",
	"application/config/use_custom_user_dir",
]

const MOUSE_BUTTONS := {"left": MOUSE_BUTTON_LEFT, "right": MOUSE_BUTTON_RIGHT, "middle": MOUSE_BUTTON_MIDDLE, "wheel_up": MOUSE_BUTTON_WHEEL_UP, "wheel_down": MOUSE_BUTTON_WHEEL_DOWN, "wheel_left": MOUSE_BUTTON_WHEEL_LEFT, "wheel_right": MOUSE_BUTTON_WHEEL_RIGHT, "xbutton1": MOUSE_BUTTON_XBUTTON1, "xbutton2": MOUSE_BUTTON_XBUTTON2}
const JOY_BUTTONS := {"a": JOY_BUTTON_A, "b": JOY_BUTTON_B, "x": JOY_BUTTON_X, "y": JOY_BUTTON_Y, "back": JOY_BUTTON_BACK, "guide": JOY_BUTTON_GUIDE, "start": JOY_BUTTON_START, "left_stick": JOY_BUTTON_LEFT_STICK, "right_stick": JOY_BUTTON_RIGHT_STICK, "left_shoulder": JOY_BUTTON_LEFT_SHOULDER, "right_shoulder": JOY_BUTTON_RIGHT_SHOULDER, "dpad_up": JOY_BUTTON_DPAD_UP, "dpad_down": JOY_BUTTON_DPAD_DOWN, "dpad_left": JOY_BUTTON_DPAD_LEFT, "dpad_right": JOY_BUTTON_DPAD_RIGHT}
const JOY_AXES := {"left_x": JOY_AXIS_LEFT_X, "left_y": JOY_AXIS_LEFT_Y, "right_x": JOY_AXIS_RIGHT_X, "right_y": JOY_AXIS_RIGHT_Y, "trigger_left": JOY_AXIS_TRIGGER_LEFT, "trigger_right": JOY_AXIS_TRIGGER_RIGHT}


static func ops() -> Dictionary:
	return {
		"project_info": project_info,
		"project_settings_get": project_settings_get,
		"project_settings_set": project_settings_set,
		"input_action_set": input_action_set,
		"input_action_remove": input_action_remove,
		"autoload_set": autoload_set,
		"autoload_remove": autoload_remove,
		"project_validate": project_validate,
		"mcp_plugin_set_enabled": mcp_plugin_set_enabled,
	}


static func _resolve_uid_path(p: String) -> String:
	if p.begins_with("uid://"):
		var id := ResourceUID.text_to_id(p)
		if ResourceUID.has_id(id):
			return ResourceUID.get_id_path(id)
	return p


static func autoloads() -> Array:
	var out := []
	for info in ProjectSettings.get_property_list():
		var name := str(info["name"])
		if not name.begins_with("autoload/"):
			continue
		var raw := str(ProjectSettings.get_setting(name, ""))
		var singleton := raw.begins_with("*")
		var path := raw.substr(1) if singleton else raw
		out.append({"name": name.substr(9), "path": _resolve_uid_path(path), "raw_path": path, "singleton": singleton, "exists": ResourceLoader.exists(_resolve_uid_path(path)) or FileAccess.file_exists(_resolve_uid_path(path))})
	return out


static func _describe_event(e: InputEvent) -> Dictionary:
	var d := {"text": e.as_text(), "class": e.get_class(), "device": e.device}
	if e is InputEventKey:
		d["type"] = "key"
		d["keycode"] = OS.get_keycode_string((e as InputEventKey).keycode) if (e as InputEventKey).keycode != KEY_NONE else ""
		d["physical_keycode"] = OS.get_keycode_string((e as InputEventKey).physical_keycode) if (e as InputEventKey).physical_keycode != KEY_NONE else ""
	elif e is InputEventMouseButton:
		d["type"] = "mouse_button"
		d["button_index"] = (e as InputEventMouseButton).button_index
	elif e is InputEventJoypadButton:
		d["type"] = "joypad_button"
		d["button_index"] = (e as InputEventJoypadButton).button_index
	elif e is InputEventJoypadMotion:
		d["type"] = "joypad_motion"
		d["axis"] = (e as InputEventJoypadMotion).axis
		d["axis_value"] = (e as InputEventJoypadMotion).axis_value
	return d


static func input_actions(include_builtin: bool) -> Array:
	var out := []
	for info in ProjectSettings.get_property_list():
		var name := str(info["name"])
		if not name.begins_with("input/"):
			continue
		var action := name.substr(6)
		var builtin := action.begins_with("ui_") or action.begins_with("spatial_editor/")
		if builtin and not include_builtin:
			continue
		var v = ProjectSettings.get_setting(name)
		var events := []
		if typeof(v) == TYPE_DICTIONARY:
			for e in v.get("events", []):
				if e is InputEvent:
					events.append(_describe_event(e))
		out.append({"name": action, "deadzone": v.get("deadzone", 0.5) if typeof(v) == TYPE_DICTIONARY else 0.5, "events": events, "builtin": builtin})
	return out


static func project_info(args: Dictionary) -> Variant:
	var main_raw := str(ProjectSettings.get_setting("application/run/main_scene", ""))
	var main_scene := _resolve_uid_path(main_raw)
	var layers := {}
	for info in ProjectSettings.get_property_list():
		var n := str(info["name"])
		if n.begins_with("layer_names/"):
			var v := str(ProjectSettings.get_setting(n, ""))
			if not v.is_empty():
				layers[n.substr(12)] = v
	var classes := []
	for c in ProjectSettings.get_global_class_list():
		classes.append({"class": c.get("class"), "base": c.get("base"), "path": c.get("path"), "is_tool": c.get("is_tool", false)})
	return {
		"name": ProjectSettings.get_setting("application/config/name", ""),
		"description": ProjectSettings.get_setting("application/config/description", ""),
		"version": ProjectSettings.get_setting("application/config/version", ""),
		"features": Array(ProjectSettings.get_setting("application/config/features", PackedStringArray())),
		"main_scene": main_scene,
		"main_scene_raw": main_raw,
		"main_scene_exists": not main_scene.is_empty() and ResourceLoader.exists(main_scene),
		"rendering_method": ProjectSettings.get_setting("rendering/renderer/rendering_method", "forward_plus"),
		"viewport": [ProjectSettings.get_setting("display/window/size/viewport_width", 1152), ProjectSettings.get_setting("display/window/size/viewport_height", 648)],
		"stretch_mode": ProjectSettings.get_setting("display/window/stretch/mode", "disabled"),
		"physics_engine_3d": ProjectSettings.get_setting("physics/3d/physics_engine", "DEFAULT"),
		"autoloads": autoloads(),
		"input_actions": input_actions(bool(args.get("include_builtin_actions", false))),
		"enabled_plugins": Array(ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray())),
		"layer_names": layers,
		"global_classes": classes,
		"global_class_cache_present": FileAccess.file_exists("res://.godot/global_script_class_cache.cfg"),
		"imported": DirAccess.dir_exists_absolute("res://.godot/imported"),
	}


static func project_settings_get(args: Dictionary) -> Variant:
	var keys: Array = args.get("keys", [])
	var prefix := str(args.get("prefix", ""))
	var limit := int(args.get("limit", 200))
	var out := {}
	if keys.is_empty() and prefix.is_empty():
		return U.fail("INVALID_ARGUMENT", "Pass keys or prefix")
	for k in keys:
		var key := str(k)
		out[key] = {"exists": ProjectSettings.has_setting(key), "value": C.encode(ProjectSettings.get_setting(key), 3)}
	if not prefix.is_empty():
		var n := 0
		for info in ProjectSettings.get_property_list():
			var name := str(info["name"])
			if name.begins_with(prefix) and ProjectSettings.has_setting(name):
				if n >= limit:
					out["$truncated"] = true
					break
				out[name] = {"exists": true, "type": type_string(int(info["type"])), "value": C.encode(ProjectSettings.get_setting(name), 3)}
				n += 1
	return {"settings": out}


static func _setting_allowed(key: String) -> String:
	for d in DENIED_PREFIXES:
		if key.begins_with(d):
			return "setting '%s' cannot be changed with project_settings_set (protected prefix '%s'); use the dedicated input/autoload operations where available" % [key, d]
	for a in ALLOWED_PREFIXES:
		if key.begins_with(a):
			return ""
	return "setting '%s' is outside the allowed prefixes: %s" % [key, ", ".join(ALLOWED_PREFIXES)]


static func _setting_info(key: String) -> Dictionary:
	for info in ProjectSettings.get_property_list():
		if str(info["name"]) == key:
			return info
	return {}


static func project_settings_set(args: Dictionary) -> Variant:
	var settings = args.get("settings")
	if typeof(settings) != TYPE_DICTIONARY or (settings as Dictionary).is_empty():
		return U.fail("INVALID_ARGUMENT", "settings must be a non-empty object")
	var staged := {}
	for key in settings.keys():
		var k := str(key)
		var reason := _setting_allowed(k)
		if not reason.is_empty():
			return U.fail("PATH_NOT_ALLOWED", reason)
		var j = settings[key]
		if j == null:
			staged[k] = null
			continue
		var info := _setting_info(k)
		var value = C.decode(j, info if not info.is_empty() else {})
		if U.is_fail(value):
			return value
		if k == "application/run/main_scene":
			var p = U.to_res_path(value)
			if U.is_fail(p):
				return p
			if not ResourceLoader.exists(p) or not p.get_extension() in ["tscn", "scn"]:
				return U.fail("NOT_FOUND", "main_scene must be an existing .tscn/.scn: %s" % p)
			value = p
		staged[k] = value
	var changes := []
	for k in staged.keys():
		var before = ProjectSettings.get_setting(k) if ProjectSettings.has_setting(k) else null
		ProjectSettings.set_setting(k, staged[k])
		changes.append({"key": k, "before": C.encode(before, 2), "after": C.encode(ProjectSettings.get_setting(k) if ProjectSettings.has_setting(k) else null, 2)})
	var err := ProjectSettings.save()
	if err != OK:
		return U.godot_error(err, "ProjectSettings.save")
	return {"changes": changes}


static func _build_event(spec: Variant) -> Variant:
	if typeof(spec) != TYPE_DICTIONARY:
		return U.fail("INVALID_ARGUMENT", "Each event must be an object with a 'type'")
	var device := int(spec.get("device", -1))
	match str(spec.get("type", "")):
		"key":
			var name := str(spec.get("keycode", spec.get("key", "")))
			var code := OS.find_keycode_from_string(name)
			if code == KEY_NONE:
				return U.fail("INVALID_ARGUMENT", "Unknown key name '%s' (examples: A, Space, Left, Escape, F1, Shift)" % name)
			var e := InputEventKey.new()
			if spec.get("physical", true):
				e.physical_keycode = code
			else:
				e.keycode = code
			e.ctrl_pressed = bool(spec.get("ctrl", false))
			e.shift_pressed = bool(spec.get("shift", false))
			e.alt_pressed = bool(spec.get("alt", false))
			e.meta_pressed = bool(spec.get("meta", false))
			e.device = device
			return e
		"mouse_button":
			var b = spec.get("button_index", "left")
			var idx := int(b) if typeof(b) in [TYPE_INT, TYPE_FLOAT] else int(MOUSE_BUTTONS.get(str(b).to_lower(), 0))
			if idx <= 0:
				return U.fail("INVALID_ARGUMENT", "Unknown mouse button '%s' (%s)" % [b, ", ".join(MOUSE_BUTTONS.keys())])
			var m := InputEventMouseButton.new()
			m.button_index = idx
			m.device = device
			return m
		"joypad_button":
			var jb = spec.get("button_index", "a")
			var jidx := int(jb) if typeof(jb) in [TYPE_INT, TYPE_FLOAT] else int(JOY_BUTTONS.get(str(jb).to_lower(), -1))
			if jidx < 0:
				return U.fail("INVALID_ARGUMENT", "Unknown joypad button '%s' (%s)" % [jb, ", ".join(JOY_BUTTONS.keys())])
			var jbe := InputEventJoypadButton.new()
			jbe.button_index = jidx
			jbe.device = device
			return jbe
		"joypad_motion":
			var ax = spec.get("axis", "left_x")
			var aidx := int(ax) if typeof(ax) in [TYPE_INT, TYPE_FLOAT] else int(JOY_AXES.get(str(ax).to_lower(), -1))
			if aidx < 0:
				return U.fail("INVALID_ARGUMENT", "Unknown joypad axis '%s' (%s)" % [ax, ", ".join(JOY_AXES.keys())])
			var jm := InputEventJoypadMotion.new()
			jm.axis = aidx
			jm.axis_value = -1.0 if float(spec.get("axis_value", 1.0)) < 0 else 1.0
			jm.device = device
			return jm
	return U.fail("INVALID_ARGUMENT", "Event type must be key, mouse_button, joypad_button or joypad_motion")


static func input_action_set(args: Dictionary) -> Variant:
	var action := str(args.get("action", "")).strip_edges()
	if action.is_empty() or action.contains("/") or action.contains("\"") or action.length() > 128:
		return U.fail("INVALID_ARGUMENT", "action must be a simple name")
	var events := []
	var key := "input/" + action
	var existing = ProjectSettings.get_setting(key) if ProjectSettings.has_setting(key) else null
	if not bool(args.get("replace", true)) and typeof(existing) == TYPE_DICTIONARY:
		events = Array(existing.get("events", [])).duplicate()
	for spec in args.get("events", []):
		var e = _build_event(spec)
		if U.is_fail(e):
			return e
		var dup := false
		for old in events:
			if old is InputEvent and (old as InputEvent).is_match(e, true):
				dup = true
		if not dup:
			events.append(e)
	var deadzone := float(args.get("deadzone", existing.get("deadzone", 0.5) if typeof(existing) == TYPE_DICTIONARY else 0.5))
	ProjectSettings.set_setting(key, {"deadzone": deadzone, "events": events})
	var err := ProjectSettings.save()
	if err != OK:
		return U.godot_error(err, "ProjectSettings.save")
	var described := []
	for e in events:
		described.append(_describe_event(e))
	return {"action": action, "deadzone": deadzone, "events": described, "created": existing == null}


static func input_action_remove(args: Dictionary) -> Variant:
	var action := str(args.get("action", ""))
	var key := "input/" + action
	if not ProjectSettings.has_setting(key):
		return U.fail("NOT_FOUND", "Input action '%s' does not exist" % action)
	ProjectSettings.set_setting(key, null)
	var err := ProjectSettings.save()
	if err != OK:
		return U.godot_error(err, "ProjectSettings.save")
	return {"removed": action}


static func autoload_set(args: Dictionary) -> Variant:
	var name := str(args.get("name", ""))
	if not name.is_valid_identifier():
		return U.fail("INVALID_ARGUMENT", "Autoload name must be a valid identifier")
	if ClassDB.class_exists(name) or Engine.has_singleton(name):
		return U.fail("CONFLICT", "Autoload name '%s' collides with an engine class or singleton" % name)
	for c in ProjectSettings.get_global_class_list():
		if str(c.get("class")) == name:
			return U.fail("CONFLICT", "Autoload name '%s' collides with the project class_name in %s" % [name, c.get("path")])
	var path = U.to_res_path(args.get("path"))
	if U.is_fail(path):
		return path
	if not path.get_extension() in ["gd", "tscn", "scn", "cs"]:
		return U.fail("INVALID_ARGUMENT", "Autoload path must be a .gd, .cs, .tscn or .scn file")
	if not FileAccess.file_exists(path):
		return U.fail("NOT_FOUND", "Autoload file does not exist: %s" % path)
	var key := "autoload/" + name
	var existed := ProjectSettings.has_setting(key)
	ProjectSettings.set_setting(key, ("*" if bool(args.get("singleton", true)) else "") + path)
	var err := ProjectSettings.save()
	if err != OK:
		return U.godot_error(err, "ProjectSettings.save")
	return {"name": name, "path": path, "singleton": bool(args.get("singleton", true)), "replaced": existed}


static func autoload_remove(args: Dictionary) -> Variant:
	var key := "autoload/" + str(args.get("name", ""))
	if not ProjectSettings.has_setting(key):
		return U.fail("NOT_FOUND", "Autoload '%s' does not exist" % args.get("name", ""))
	ProjectSettings.set_setting(key, null)
	var err := ProjectSettings.save()
	if err != OK:
		return U.godot_error(err, "ProjectSettings.save")
	return {"removed": args.get("name")}


# ------------------------------------------------------------- validation

const VALIDATE_EXT := ["tscn", "scn", "tres", "res", "gd", "gdshader"]


static func collect_files(dir: String, exts: Array, include_addons: bool, out: Array, limit: int) -> void:
	if out.size() >= limit:
		return
	var da := DirAccess.open(dir)
	if da == null:
		return
	da.include_hidden = false
	for f in da.get_files():
		if out.size() >= limit:
			return
		if f.get_extension().to_lower() in exts:
			out.append(dir.path_join(f))
	for sub in da.get_directories():
		if sub.begins_with("."):
			continue
		if not include_addons and dir == "res://" and sub == "addons":
			continue
		if FileAccess.file_exists(dir.path_join(sub).path_join(".gdignore")):
			continue
		collect_files(dir.path_join(sub), exts, include_addons, out, limit)


static func dependency_problems(path: String) -> Array:
	var missing := []
	for dep in ResourceLoader.get_dependencies(path):
		var parts := str(dep).split("::")
		var dep_path := ""
		var uid := ""
		for p in parts:
			if p.begins_with("res://"):
				dep_path = p
			elif p.begins_with("uid://"):
				uid = p
		var ok := false
		if not dep_path.is_empty() and (ResourceLoader.exists(dep_path) or FileAccess.file_exists(dep_path)):
			ok = true
		elif not uid.is_empty() and ResourceUID.has_id(ResourceUID.text_to_id(uid)):
			ok = true
		if not ok:
			missing.append({"dependency": dep_path if not dep_path.is_empty() else uid, "uid": uid})
	return missing


static func _take_logs() -> Array:
	var lg = Engine.get_meta("godot_mcp_logger", null)
	return lg.take() if lg != null else []


static func classify_diagnostics(diags: Array, autoload_names: Array) -> Array:
	for d in diags:
		var m := str(d.get("message", ""))
		for a in autoload_names:
			if m.contains("Identifier not found: %s" % a) or m.contains("Identifier \"%s\" not declared" % a):
				d["severity"] = "info"
				d["note"] = "Reference to autoload '%s' cannot be resolved headlessly (autoloads are not registered in the worker); this is not a real error. Validate through the editor bridge or a runtime test for full coverage." % a
	return diags


static func project_validate(args: Dictionary) -> Variant:
	var limit := clampi(int(args.get("max_files", 3000)), 1, 20000)
	var files := []
	collect_files("res://", VALIDATE_EXT, bool(args.get("include_addons", false)), files, limit)
	var autoload_names := []
	for a in autoloads():
		autoload_names.append(a["name"])
	_take_logs()
	var problems := []
	var checked := 0
	for path in files:
		checked += 1
		var entry := {"path": path}
		var missing := dependency_problems(path)
		if not missing.is_empty():
			entry["missing_dependencies"] = missing
		var res = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		var diags := classify_diagnostics(_take_logs(), autoload_names)
		var real := diags.filter(func(d): return d.get("severity") != "info" and d.get("severity") != "warning")
		if res == null and real.is_empty() and not autoload_names.is_empty() and diags.size() > 0:
			entry["note"] = "Loading failed only because of autoload references; see diagnostics"
		elif res == null:
			entry["load_failed"] = true
		elif res is PackedScene and not (res as PackedScene).can_instantiate():
			entry["load_failed"] = true
			entry["reason"] = "PackedScene cannot be instantiated"
		if not diags.is_empty():
			entry["diagnostics"] = diags
		if entry.size() > 1:
			problems.append(entry)
	var project := {}
	var main := _resolve_uid_path(str(ProjectSettings.get_setting("application/run/main_scene", "")))
	project["main_scene"] = main
	if main.is_empty():
		project["main_scene_problem"] = "No main scene configured (application/run/main_scene)"
	elif not ResourceLoader.exists(main):
		project["main_scene_problem"] = "Main scene does not exist: %s" % main
	var bad_autoloads := []
	for a in autoloads():
		if not a["exists"]:
			bad_autoloads.append(a)
	project["missing_autoloads"] = bad_autoloads
	var errors := 0
	for p in problems:
		if p.has("load_failed") or p.has("missing_dependencies"):
			errors += 1
		else:
			for d in p.get("diagnostics", []):
				if d.get("severity") in ["error", "script_error", "shader_error"]:
					errors += 1
					break
	if project.has("main_scene_problem"):
		errors += 1
	errors += bad_autoloads.size()
	return {
		"files_checked": checked,
		"truncated": files.size() >= limit,
		"files_with_problems": problems.size(),
		"error_count": errors,
		"healthy": errors == 0,
		"problems": problems,
		"project": project,
		"note": "Loading scripts runs their static initialisers; autoload singletons are not instantiated.",
	}


const MCP_PLUGIN_CFG := "res://addons/godot_mcp/plugin.cfg"


## Enable/disable ONLY the godot-mcp bridge plugin (editor_plugins/enabled is
## otherwise protected). Takes effect the next time the editor starts.
static func mcp_plugin_set_enabled(args: Dictionary) -> Variant:
	if not FileAccess.file_exists(MCP_PLUGIN_CFG):
		return U.fail("NOT_FOUND", "The godot-mcp plugin is not installed at %s" % MCP_PLUGIN_CFG)
	var list := PackedStringArray(ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray()))
	var enable := bool(args.get("enabled", true))
	var idx := list.find(MCP_PLUGIN_CFG)
	if enable and idx < 0:
		list.append(MCP_PLUGIN_CFG)
	elif not enable and idx >= 0:
		list.remove_at(idx)
	else:
		return {"enabled": enable, "changed": false}
	ProjectSettings.set_setting("editor_plugins/enabled", list)
	var err := ProjectSettings.save()
	if err != OK:
		return U.godot_error(err, "ProjectSettings.save")
	return {"enabled": enable, "changed": true, "enabled_plugins": Array(list)}
