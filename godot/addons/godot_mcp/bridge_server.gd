@tool
extends Node
## Loopback JSON-lines server for the godot-mcp editor bridge.
##
## Wire protocol (one JSON object per line, UTF-8):
##   client -> {"type":"hello","token":"<hex>","protocol":1}
##   server -> {"type":"welcome","protocol":1,"project_root":...,"godot_version":...}
##   client -> {"id":1,"method":"status","params":{}}
##   server -> {"id":1,"ok":true,"result":{...}} | {"id":1,"ok":false,"error":{"code","message"}}
## Unauthenticated peers are dropped after a bad/missing hello or 5 seconds.

const PROTOCOL := 1
const MAX_MESSAGE_BYTES := 1024 * 1024
const MAX_CLIENTS := 4
const AUTH_TIMEOUT_MS := 5000
const Ops = preload("editor_ops.gd")

var plugin: EditorPlugin
var _server: TCPServer
var _token := ""
var _clients: Array = []
var _ops: RefCounted
var _info_path := "res://.godot/godot_mcp/bridge.json"


class Client:
	var peer: StreamPeerTCP
	var buffer := PackedByteArray()
	var authed := false
	var connected_at := 0


func start() -> int:
	_ops = Ops.new(plugin)
	_server = TCPServer.new()
	var err := _server.listen(0, "127.0.0.1")
	if err != OK:
		return err
	_token = Crypto.new().generate_random_bytes(32).hex_encode()
	var info := {
		"protocol": PROTOCOL,
		"port": _server.get_local_port(),
		"token": _token,
		"pid": OS.get_process_id(),
		"project_root": ProjectSettings.globalize_path("res://"),
		"godot_version": Engine.get_version_info().get("string", ""),
		"started_at": Time.get_datetime_string_from_system(true),
	}
	# Owner-only from the start: the directory first, then the (still empty)
	# file, and only then the token, so no other local user can ever read it.
	var dir := _info_path.get_base_dir()
	DirAccess.make_dir_recursive_absolute(dir)
	FileAccess.set_unix_permissions(dir, FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER | FileAccess.UNIX_EXECUTE_OWNER)
	var f := FileAccess.open(_info_path, FileAccess.WRITE)
	if f == null:
		_server.stop()
		return FileAccess.get_open_error()
	f.close()
	FileAccess.set_unix_permissions(_info_path, FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER)
	f = FileAccess.open(_info_path, FileAccess.WRITE)
	if f == null:
		_server.stop()
		return FileAccess.get_open_error()
	f.store_string(JSON.stringify(info))
	f.close()
	# Godot 4.5 writes through a temporary file that replaces this one (with
	# default permissions; the owner-only directory still protects it).
	FileAccess.set_unix_permissions(_info_path, FileAccess.UNIX_READ_OWNER | FileAccess.UNIX_WRITE_OWNER)
	print("Godot MCP bridge listening on 127.0.0.1:%d" % _server.get_local_port())
	return OK


func stop() -> void:
	for c in _clients:
		c.peer.disconnect_from_host()
	_clients.clear()
	if _server != null:
		_server.stop()
	# Only remove the discovery file if it is still ours (another editor may have replaced it).
	if FileAccess.file_exists(_info_path):
		var data = JSON.parse_string(FileAccess.get_file_as_string(_info_path))
		if typeof(data) == TYPE_DICTIONARY and str(data.get("token", "")) == _token:
			DirAccess.remove_absolute(ProjectSettings.globalize_path(_info_path))
	if _ops != null and _ops.has_method("shutdown"):
		_ops.shutdown()


func _process(_delta: float) -> void:
	if _server == null or not _server.is_listening():
		return
	while _server.is_connection_available():
		var peer := _server.take_connection()
		if _clients.size() >= MAX_CLIENTS:
			peer.disconnect_from_host()
			continue
		var c := Client.new()
		c.peer = peer
		c.connected_at = Time.get_ticks_msec()
		_clients.append(c)
	var alive := []
	for c in _clients:
		if _pump(c):
			alive.append(c)
		else:
			c.peer.disconnect_from_host()
	_clients = alive


## Returns false when the client must be dropped.
func _pump(c: Client) -> bool:
	c.peer.poll()
	var status := c.peer.get_status()
	if status != StreamPeerTCP.STATUS_CONNECTED:
		return status == StreamPeerTCP.STATUS_CONNECTING
	if not c.authed and Time.get_ticks_msec() - c.connected_at > AUTH_TIMEOUT_MS:
		return false
	var avail := c.peer.get_available_bytes()
	if avail > 0:
		var got := c.peer.get_data(avail)
		if got[0] != OK:
			return false
		c.buffer.append_array(got[1])
	if c.buffer.size() > MAX_MESSAGE_BYTES:
		_send(c, {"ok": false, "error": {"code": "INVALID_ARGUMENT", "message": "Message too large"}})
		return false
	while true:
		var nl := c.buffer.find(10)
		if nl < 0:
			break
		var line := c.buffer.slice(0, nl).get_string_from_utf8()
		c.buffer = c.buffer.slice(nl + 1)
		if not _handle_line(c, line):
			return false
	return true


func _handle_line(c: Client, line: String) -> bool:
	var msg = JSON.parse_string(line)
	if typeof(msg) != TYPE_DICTIONARY:
		_send(c, {"ok": false, "error": {"code": "INVALID_ARGUMENT", "message": "Malformed JSON"}})
		return c.authed
	if not c.authed:
		var tok := str(msg.get("token", ""))
		var ok: bool = msg.get("type") == "hello" and tok.length() == _token.length() and Crypto.new().constant_time_compare(tok.to_utf8_buffer(), _token.to_utf8_buffer())
		if not ok:
			_send(c, {"type": "rejected", "error": {"code": "EDITOR_REJECTED", "message": "Authentication failed"}})
			return false
		c.authed = true
		_send(c, {"type": "welcome", "protocol": PROTOCOL, "project_root": ProjectSettings.globalize_path("res://"), "godot_version": Engine.get_version_info().get("string", "")})
		return true
	var id = msg.get("id")
	var method := str(msg.get("method", ""))
	var params = msg.get("params", {})
	if typeof(params) != TYPE_DICTIONARY:
		params = {}
	var result = _ops.dispatch(method, params)
	if result == null:
		# Every method returns a result or an error; null means a runtime error
		# aborted it (see the editor's Output panel), so never report success.
		_send(c, {"id": id, "ok": false, "error": {"code": "INTERNAL", "message": "Editor operation '%s' failed with an internal error (malformed parameters? see the editor output)" % method}})
	elif typeof(result) == TYPE_DICTIONARY and (result as Dictionary).has("__error"):
		_send(c, {"id": id, "ok": false, "error": result["__error"]})
	else:
		_send(c, {"id": id, "ok": true, "result": result})
	return true


func _send(c: Client, data: Dictionary) -> void:
	var bytes := (JSON.stringify(data) + "\n").to_utf8_buffer()
	c.peer.put_data(bytes)
