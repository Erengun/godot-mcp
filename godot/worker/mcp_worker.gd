extends MainLoop
## godot-mcp headless worker.
##
## Runs as `godot --headless --path <project> --script mcp_worker.gd -- <request.json> <response.json>`.
## It extends MainLoop (not SceneTree) on purpose: with a MainLoop, Godot does
## not instantiate the project's autoload singletons, so no project code runs
## unless an operation explicitly loads or instantiates it.
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

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		_mutex.lock()
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


func _initialize() -> void:
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
	OS.add_logger(_logger)
	Engine.set_meta("godot_mcp_logger", _logger)
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
			var value = callable.call(op_args)
			if U.is_fail(value):
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
