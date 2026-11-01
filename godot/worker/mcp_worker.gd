extends SceneTree
## godot-mcp headless worker.
##
## Runs as `godot --headless --path <project> --script mcp_worker.gd -- <request.json> <response.json>`.
## Project scripts that use autoload singletons only compile once those names
## are registered, which Godot does for a SceneTree main loop before any
## project script loads, by instantiating each autoload. Before that happens,
## `_init()` points every autoload at an inert placeholder node, so the names
## exist but no autoload code runs. `_initialize()` restores the real settings
## (in memory only) and removes the placeholder's script, so the analyzer types
## a script autoload from its real script and a scene autoload as a plain Node.
## The tree never runs a frame: once the response is written the process ends
## at once, so nodes, signals or deferred calls that project code (setters,
## _init) may have set up during an operation never get to run.
##
## The request lists operations; they run in order and the batch stops at the
## first failure. The response file is the only result channel.

const PROTOCOL := 1
const U = preload("../addons/godot_mcp/lib/mcp_util.gd")
const OP_MODULES := [
	preload("ops/project_ops.gd"),
	preload("ops/scene_ops.gd"),
	preload("ops/resource_ops.gd"),
	preload("ops/script_ops.gd"),
	preload("ops/api_ops.gd"),
	preload("ops/asset_ops.gd"),
]


class CaptureLogger extends Logger:
	var records: Array = []
	var _mutex := Mutex.new()
	const LIMIT := 300
	const SEVERITY := ["error", "warning", "script_error", "shader_error"]
	## Directory holding the worker's own GDScript (godot/ in the package).
	var worker_root := ""
	## Runtime errors raised by the worker's own scripts (not the project's).
	## Such an error aborts the function it happened in, which then returns
	## null, so ops use this count to tell a crash from a result.
	var crashes := 0
	## Runtime errors raised by the project's scripts (setters, _set, _init...).
	var project_errors := 0

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		_mutex.lock()
		if error_type == ERROR_TYPE_SCRIPT and not worker_root.is_empty() and file.begins_with(worker_root):
			crashes += 1
		elif error_type == ERROR_TYPE_SCRIPT and file.begins_with("res://"):
			project_errors += 1
		if records.size() < LIMIT:
			var msg := rationale if not rationale.is_empty() else code
			if not rationale.is_empty() and not code.is_empty() and rationale != code:
				msg = "%s (%s)" % [rationale, code]
			records.append({
				"severity": SEVERITY[error_type] if error_type >= 0 and error_type < SEVERITY.size() else "error",
				"message": msg,
				"file": file,
				"line": line,
				"function": function,
			})
		_mutex.unlock()

	func _log_message(_message: String, _error: bool) -> void:
		pass

	func take() -> Array:
		_mutex.lock()
		var out := records
		records = []
		_mutex.unlock()
		return out


var _logger: CaptureLogger
## autoload/<name> setting -> its real value, while the placeholders are in place.
var _autoloads := {}


func _init() -> void:
	var placeholder := (get_script() as Script).resource_path.get_base_dir().path_join("autoload_placeholder.gd")
	for p in ProjectSettings.get_property_list():
		var key := str(p["name"])
		if key.begins_with("autoload/"):
			var value := str(ProjectSettings.get_setting(key))
			_autoloads[key] = value
			ProjectSettings.set_setting(key, ("*" if value.begins_with("*") else "") + placeholder)


func _initialize() -> void:
	for key in _autoloads:
		ProjectSettings.set_setting(key, _autoloads[key])
	for n in root.get_children():
		n.set_script(null)
	_run()
	# Not quit(): that would still run one frame of the tree.
	OS.kill(OS.get_process_id())


func _run() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 2:
		printerr("godot-mcp worker: expected <request.json> <response.json>")
		return
	var response_path := args[1]
	var response := {"protocol": PROTOCOL, "ok": false, "results": [], "diagnostics": [], "engine": {"version": Engine.get_version_info().get("string", "")}}
	var raw := FileAccess.get_file_as_string(args[0])
	var request = JSON.parse_string(raw)
	if typeof(request) != TYPE_DICTIONARY or typeof(request.get("ops")) != TYPE_ARRAY:
		response["error"] = {"code": "INVALID_ARGUMENT", "message": "Malformed worker request"}
		_write(response_path, response)
		return

	var registry := {}
	for module in OP_MODULES:
		var ops: Dictionary = module.ops()
		for k in ops.keys():
			registry[k] = ops[k]

	U.register_project_uids()
	_logger = CaptureLogger.new()
	# godot/worker/mcp_worker.gd -> godot/ (also contains the shared addon library).
	_logger.worker_root = (get_script() as Script).resource_path.get_base_dir().get_base_dir() + "/"
	OS.add_logger(_logger)
	Engine.set_meta("godot_mcp_logger", _logger)
	# Private directory of this request (see worker.ts), for comparison copies.
	Engine.set_meta("godot_mcp_tmp", response_path.get_base_dir())
	var all_ok := true
	for entry in request["ops"]:
		var op_name := str(entry.get("op", ""))
		var op_args = entry.get("args", {})
		if typeof(op_args) != TYPE_DICTIONARY:
			op_args = {}
		var result := {"op": op_name, "ok": false}
		if not registry.has(op_name):
			result["error"] = {"code": "INVALID_ARGUMENT", "message": "Unknown worker operation: %s" % op_name}
		else:
			var callable: Callable = registry[op_name]
			var crashes_before := _logger.crashes
			var value = callable.call(op_args)
			if value == null or _logger.crashes > crashes_before:
				# Every op returns a result or a failure; null means it was aborted by
				# a runtime error in the worker's own code (see the diagnostics).
				result["error"] = {"code": "INTERNAL", "message": "Worker operation '%s' failed with an internal error (malformed arguments? see diagnostics)" % op_name}
			elif U.is_fail(value):
				result["error"] = value[U.ERR_KEY]
			else:
				result["ok"] = true
				result["result"] = value
		response["results"].append(result)
		if not result["ok"]:
			all_ok = false
			if request.get("atomic", true):
				break
	response["ok"] = all_ok
	response["diagnostics"] = _logger.take()
	OS.remove_logger(_logger)
	Engine.remove_meta("godot_mcp_logger")
	_write(response_path, response)


func _write(path: String, data: Dictionary) -> void:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		printerr("godot-mcp worker: cannot write response: ", error_string(FileAccess.get_open_error()))
		return
	f.store_string(JSON.stringify(data))
	f.close()


func _process(_delta: float) -> bool:
	return true
