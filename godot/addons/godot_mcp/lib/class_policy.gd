@tool
extends RefCounted
## Which classes an MCP client may instantiate.
##
## Only these are allowed:
##  * engine classes registered in ClassDB that can be instantiated, inherit
##    from the required base (Node or Resource), are not editor-only, and are
##    not in the deny list below; or
##  * project classes registered with `class_name` (global script class
##    registry) whose native base satisfies the same rules.
## Raw script paths are never accepted as a "type".

const U = preload("mcp_util.gd")

## Classes (and their subclasses) that can execute code, load native code or
## control the engine/editor and therefore must never be created from a
## client-supplied type name.
const DENY_BASES: Array[String] = [
	"Script", "ScriptExtension", "GDExtension", "EditorPlugin", "EditorScript",
	"EditorImportPlugin", "EditorExportPlugin", "EditorInspectorPlugin",
	"ResourceFormatLoader", "ResourceFormatSaver", "MainLoop", "Thread",
	"JavaClassWrapper", "JavaScriptBridge", "WorkerThreadPool", "EditorSettings",
]


static func _denied(cls: String) -> bool:
	for base in DENY_BASES:
		if ClassDB.class_exists(base) and (cls == base or ClassDB.is_parent_class(cls, base)):
			return true
	if ClassDB.class_exists(cls) and ClassDB.class_get_api_type(cls) in [ClassDB.API_EDITOR, ClassDB.API_EDITOR_EXTENSION]:
		return true
	return false


static func find_global_class(name: String) -> Dictionary:
	for entry in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) == name:
			return entry
	return {}


## Native base class of a global script class (follows script inheritance).
static func global_class_native_base(name: String) -> String:
	var seen := {}
	var current := name
	while not current.is_empty() and not seen.has(current):
		seen[current] = true
		if ClassDB.class_exists(current):
			return current
		var entry := find_global_class(current)
		if entry.is_empty():
			return ""
		current = str(entry.get("base", ""))
	return ""


## Returns "" when allowed, otherwise a human-readable reason.
static func check(cls: String, required_base: String) -> String:
	if not cls.is_valid_identifier():
		return "'%s' is not a valid class identifier" % cls
	if ClassDB.class_exists(cls):
		if _denied(cls):
			return "class '%s' is not allowed (it can execute code or is editor-only)" % cls
		if cls != required_base and not ClassDB.is_parent_class(cls, required_base):
			return "class '%s' does not inherit %s" % [cls, required_base]
		if not ClassDB.can_instantiate(cls):
			return "class '%s' is abstract or cannot be instantiated" % cls
		return ""
	var entry := find_global_class(cls)
	if entry.is_empty():
		return "unknown class '%s' (not a built-in class nor a project class_name)" % cls
	var native := global_class_native_base(cls)
	if native.is_empty():
		return "could not resolve the native base of project class '%s'" % cls
	if _denied(native):
		return "project class '%s' extends a denied base (%s)" % [cls, native]
	if native != required_base and not ClassDB.is_parent_class(native, required_base):
		return "project class '%s' does not inherit %s" % [cls, required_base]
	return ""


## Instantiate an allowed class. Returns the object or a fail() Dictionary.
static func create(cls: String, required_base: String) -> Variant:
	var reason := check(cls, required_base)
	if not reason.is_empty():
		return U.fail("CLASS_NOT_ALLOWED", reason, {"class": cls})
	if ClassDB.class_exists(cls):
		var obj = ClassDB.instantiate(cls)
		if obj == null:
			return U.fail("OPERATION_FAILED", "ClassDB.instantiate returned null for %s" % cls)
		return obj
	var entry := find_global_class(cls)
	var script = ResourceLoader.load(str(entry.get("path", "")), "Script")
	if script == null or not (script is Script) or not script.can_instantiate():
		return U.fail("OPERATION_FAILED", "Project class '%s' failed to load (see diagnostics)" % cls, {"path": entry.get("path", "")})
	var inst = script.new()
	if inst == null:
		return U.fail("OPERATION_FAILED", "Project class '%s' could not be instantiated" % cls)
	return inst


static func is_resource_class_allowed(cls: String) -> bool:
	return check(cls, "Resource").is_empty()
