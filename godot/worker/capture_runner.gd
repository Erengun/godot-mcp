extends SceneTree
## Renders a scene with the real renderer and saves the viewport to PNG.
##
## Runs as `godot --path <project> --resolution WxH --script capture_runner.gd -- <request.json> <response.json>`
## WITHOUT --headless (a headless display driver cannot render). Unlike in the
## worker, the project's autoloads really run here — the
## scene is genuinely executed, exactly as when the game runs.

const PROTOCOL := 1
const U = preload("../addons/godot_mcp/lib/mcp_util.gd")

var _req: Dictionary = {}
var _res_path := ""
var _frame := 0
var _target_frames := 10
var _scene_root: Node
var _logger: CaptureLogger
var _done := false


class CaptureLogger extends Logger:
	var records: Array = []
	var _mutex := Mutex.new()
	const SEVERITY := ["error", "warning", "script_error", "shader_error"]

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _n: bool, error_type: int, _bt: Array[ScriptBacktrace]) -> void:
		_mutex.lock()
		if records.size() < 200:
			records.append({"severity": SEVERITY[error_type] if error_type < SEVERITY.size() else "error", "message": rationale if not rationale.is_empty() else code, "file": file, "line": line, "function": function})
		_mutex.unlock()

	func _log_message(_m: String, _e: bool) -> void:
		pass


func _initialize() -> void:
	_logger = CaptureLogger.new()
	OS.add_logger(_logger)
	var args := OS.get_cmdline_user_args()
	if args.size() < 2:
		printerr("capture_runner: expected <request.json> <response.json>")
		quit(2)
		return
	_res_path = args[1]
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	if typeof(parsed) != TYPE_DICTIONARY:
		_finish({"ok": false, "error": {"code": "INVALID_ARGUMENT", "message": "Malformed capture request"}})
		return
	_req = parsed
	_target_frames = clampi(int(_req.get("frames", 10)), 2, 600)


func _process(_delta: float) -> bool:
	if _done:
		return true
	_frame += 1
	if _frame == 1:
		var err = _load_scene()
		if U.is_fail(err):
			_finish({"ok": false, "error": err[U.ERR_KEY]})
	elif _frame == _target_frames:
		RenderingServer.frame_post_draw.connect(_capture, CONNECT_ONE_SHOT)
	elif _frame > _target_frames + 120:
		_finish({"ok": false, "error": {"code": "TIMEOUT", "message": "frame_post_draw never fired (no rendering?)"}})
	return false


func _load_scene() -> Variant:
	var path = U.to_res_path(_req.get("scene", ""))
	if U.is_fail(path):
		return path
	var ps = ResourceLoader.load(path, "PackedScene")
	if not (ps is PackedScene):
		return U.fail("NOT_FOUND", "Scene %s could not be loaded" % path)
	_scene_root = (ps as PackedScene).instantiate()
	if _scene_root == null:
		return U.fail("OPERATION_FAILED", "Scene %s could not be instantiated" % path)
	root.add_child(_scene_root)
	current_scene = _scene_root
	var cam_path := str(_req.get("camera", ""))
	if not cam_path.is_empty():
		var cam := U.find_node(_scene_root, cam_path)
		if cam is Camera3D:
			(cam as Camera3D).make_current()
		elif cam is Camera2D:
			(cam as Camera2D).make_current()
		else:
			return U.fail("NOT_FOUND", "Camera node not found or not a camera: %s" % cam_path)
	return null


func _capture() -> void:
	var img := root.get_texture().get_image()
	if img == null or img.is_empty():
		_finish({"ok": false, "error": {"code": "OPERATION_FAILED", "message": "Viewport texture returned no image"}})
		return
	var out_png := str(_req.get("out", ""))
	var err := img.save_png(out_png)
	if err != OK:
		_finish({"ok": false, "error": {"code": "OPERATION_FAILED", "message": "save_png failed: %s" % error_string(err)}})
		return
	_finish({"ok": true, "image": {"path": out_png, "width": img.get_width(), "height": img.get_height()}, "stats": _image_stats(img), "scene": _scene_facts()})


func _image_stats(img: Image) -> Dictionary:
	var w := img.get_width()
	var h := img.get_height()
	var counts := {}
	var lum := 0.0
	var samples := 0
	var step := maxi(1, int(min(w, h) / 64.0))
	for y in range(0, h, step):
		for x in range(0, w, step):
			var c := img.get_pixel(x, y)
			var key := "%02x%02x%02x" % [int(c.r * 15), int(c.g * 15), int(c.b * 15)]
			counts[key] = counts.get(key, 0) + 1
			lum += c.get_luminance()
			samples += 1
	var top := 0
	for k in counts:
		top = maxi(top, counts[k])
	return {
		"samples": samples,
		"distinct_colors_4bit": counts.size(),
		"dominant_color_fraction": float(top) / maxf(1.0, samples),
		"non_background_fraction": 1.0 - float(top) / maxf(1.0, samples),
		"mean_luminance": lum / maxf(1.0, samples),
		"looks_blank": counts.size() <= 1,
	}


func _scene_facts() -> Dictionary:
	var facts := {"meshes": 0, "meshes_missing": 0, "meshes_in_view": 0, "sprites": 0, "sprites_missing_texture": 0, "lights": 0, "visible_controls": 0}
	var cam3 := root.get_camera_3d()
	var cam2 := root.get_camera_2d()
	facts["camera_3d"] = str(_scene_root.get_path_to(cam3)) if cam3 != null and _scene_root.is_ancestor_of(cam3) else null
	facts["camera_2d"] = str(_scene_root.get_path_to(cam2)) if cam2 != null and _scene_root.is_ancestor_of(cam2) else null
	var stack: Array[Node] = [_scene_root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n is MeshInstance3D and (n as MeshInstance3D).is_visible_in_tree():
			facts["meshes"] += 1
			var mi := n as MeshInstance3D
			if mi.mesh == null:
				facts["meshes_missing"] += 1
			elif cam3 != null:
				var center := mi.global_transform * mi.get_aabb().get_center()
				if cam3.is_position_in_frustum(center):
					facts["meshes_in_view"] += 1
		elif n is Sprite2D and (n as Sprite2D).is_visible_in_tree():
			facts["sprites"] += 1
			if (n as Sprite2D).texture == null:
				facts["sprites_missing_texture"] += 1
		elif n is Light3D and (n as Light3D).is_visible_in_tree():
			facts["lights"] += 1
		elif n is Control and (n as Control).is_visible_in_tree():
			facts["visible_controls"] += 1
		for c in n.get_children():
			stack.append(c)
	return facts


func _finish(result: Dictionary) -> void:
	if _done:
		return
	_done = true
	result["protocol"] = PROTOCOL
	result["diagnostics"] = _logger.records if _logger != null else []
	var f := FileAccess.open(_res_path, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify(result))
		f.close()
	if _logger != null:
		OS.remove_logger(_logger)
	quit(0 if result.get("ok", false) else 1)
