@tool
extends RefCounted
## Type-directed conversion between JSON values and Godot Variants.
##
## Encoding (Godot -> JSON) is lossless for value types and uses an explicit
## "$type" tag for anything JSON cannot represent:
##   Vector2/3/4(i), Quaternion, Color, Plane   {"$type":"Vector3","value":[x,y,z]}
##   Rect2(i), AABB                             {"$type":"Rect2","position":[..],"size":[..]}
##   Transform2D                                {"$type":"Transform2D","x":[..],"y":[..],"origin":[..]}
##   Basis                                      {"$type":"Basis","x":[..],"y":[..],"z":[..]}
##   Transform3D                                {"$type":"Transform3D","basis":{x,y,z},"origin":[..]}
##   Projection                                 {"$type":"Projection","value":[[4],[4],[4],[4]]}
##   StringName / NodePath                      {"$type":"NodePath","value":"A/B"}
##   Packed*Array                               {"$type":"PackedVector2Array","value":[[x,y],...]}
##   Dictionary with non-string keys            {"$type":"Dictionary","entries":[[k,v],...]}
##   Resource saved in its own file             {"$type":"Resource","class":"Texture2D","path":"res://a.png"}
##   Embedded sub-resource                      {"$type":"Resource","class":"BoxMesh","embedded":true,"properties":{...}}
##   Non-finite float                           {"$type":"float","value":"inf"}
##
## Decoding (JSON -> Godot) is driven by the target property's declared type,
## so agents can write natural JSON: `"position": [10, 20]`,
## `"modulate": "#ff8800"`, `"process_mode": "PROCESS_MODE_ALWAYS"` or
## `"transform": {"origin":[0,1,0], "rotation_degrees":[0,45,0]}`.
## Strings are NEVER implicitly loaded as resources: resource values must be
## typed properties (or explicit "$type":"Resource" tags) and pass the class
## policy. Script resources are rejected unless the caller is the dedicated
## attach_script operation.

const U = preload("mcp_util.gd")
const P = preload("class_policy.gd")

const MAX_ITEMS := 512
const FORBIDDEN_PROPERTIES := ["script", "owner", "scene_file_path", "name", "_import_path"]


# ---------------------------------------------------------------- encoding

static func _arr(v) -> Array:
	var out := []
	for x in v:
		out.append(x)
	return out


static func encode(v: Variant, depth: int = 2, max_items: int = MAX_ITEMS) -> Variant:
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return v
		TYPE_FLOAT:
			if is_nan(v):
				return {"$type": "float", "value": "nan"}
			if is_inf(v):
				return {"$type": "float", "value": "inf" if v > 0 else "-inf"}
			return v
		TYPE_STRING_NAME:
			return {"$type": "StringName", "value": str(v)}
		TYPE_NODE_PATH:
			return {"$type": "NodePath", "value": str(v)}
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return {"$type": type_string(typeof(v)), "value": [v.x, v.y]}
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return {"$type": type_string(typeof(v)), "value": [v.x, v.y, v.z]}
		TYPE_VECTOR4, TYPE_VECTOR4I:
			return {"$type": type_string(typeof(v)), "value": [v.x, v.y, v.z, v.w]}
		TYPE_QUATERNION:
			return {"$type": "Quaternion", "value": [v.x, v.y, v.z, v.w]}
		TYPE_COLOR:
			return {"$type": "Color", "value": [v.r, v.g, v.b, v.a]}
		TYPE_PLANE:
			return {"$type": "Plane", "value": [v.normal.x, v.normal.y, v.normal.z, v.d]}
		TYPE_RECT2, TYPE_RECT2I:
			return {"$type": type_string(typeof(v)), "position": [v.position.x, v.position.y], "size": [v.size.x, v.size.y]}
		TYPE_AABB:
			return {"$type": "AABB", "position": [v.position.x, v.position.y, v.position.z], "size": [v.size.x, v.size.y, v.size.z]}
		TYPE_TRANSFORM2D:
			return {"$type": "Transform2D", "x": [v.x.x, v.x.y], "y": [v.y.x, v.y.y], "origin": [v.origin.x, v.origin.y]}
		TYPE_BASIS:
			return {"$type": "Basis", "x": [v.x.x, v.x.y, v.x.z], "y": [v.y.x, v.y.y, v.y.z], "z": [v.z.x, v.z.y, v.z.z]}
		TYPE_TRANSFORM3D:
			var b: Basis = v.basis
			return {
				"$type": "Transform3D",
				"basis": {"x": [b.x.x, b.x.y, b.x.z], "y": [b.y.x, b.y.y, b.y.z], "z": [b.z.x, b.z.y, b.z.z]},
				"origin": [v.origin.x, v.origin.y, v.origin.z],
			}
		TYPE_PROJECTION:
			var cols := []
			for i in 4:
				cols.append([v[i].x, v[i].y, v[i].z, v[i].w])
			return {"$type": "Projection", "value": cols}
		TYPE_RID:
			return {"$type": "RID", "unsupported": true}
		TYPE_CALLABLE:
			return {"$type": "Callable", "unsupported": true, "text": str(v)}
		TYPE_SIGNAL:
			return {"$type": "Signal", "unsupported": true, "text": str(v)}
		TYPE_OBJECT:
			return _encode_object(v, depth, max_items)
		TYPE_DICTIONARY:
			return _encode_dict(v, depth, max_items)
		TYPE_ARRAY:
			var out := []
			var n := 0
			for item in v:
				if n >= max_items:
					return {"$type": "Array", "value": out, "truncated": true, "size": v.size()}
				out.append(encode(item, depth - 1, max_items) if depth > 0 else _summary(item))
				n += 1
			return out
		TYPE_PACKED_BYTE_ARRAY:
			if v.size() > max_items:
				return {"$type": "PackedByteArray", "size": v.size(), "truncated": true}
			return {"$type": "PackedByteArray", "value": _arr(v)}
		TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY:
			var items := _arr(v)
			var trunc := items.size() > max_items
			var res := {"$type": type_string(typeof(v)), "value": items.slice(0, max_items)}
			if trunc:
				res["truncated"] = true
				res["size"] = items.size()
			return res
		TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_VECTOR4_ARRAY, TYPE_PACKED_COLOR_ARRAY:
			var vals := []
			for i in mini(v.size(), max_items):
				vals.append((encode(v[i]) as Dictionary)["value"])
			var r := {"$type": type_string(typeof(v)), "value": vals}
			if v.size() > max_items:
				r["truncated"] = true
				r["size"] = v.size()
			return r
	return {"$type": type_string(typeof(v)), "unsupported": true}


static func _summary(v: Variant) -> Variant:
	if typeof(v) in [TYPE_ARRAY, TYPE_DICTIONARY]:
		return {"$type": type_string(typeof(v)), "size": v.size(), "truncated": true}
	if typeof(v) == TYPE_OBJECT:
		return _encode_object(v, 0, 0)
	return encode(v, 0)


static func _encode_dict(d: Dictionary, depth: int, max_items: int) -> Variant:
	var plain := true
	for k in d.keys():
		if typeof(k) != TYPE_STRING or k == "$type" or k == "$new":
			plain = false
			break
	var n := 0
	if plain:
		var out := {}
		for k in d.keys():
			if n >= max_items:
				out["$truncated"] = d.size()
				break
			out[k] = encode(d[k], depth - 1, max_items) if depth > 0 else _summary(d[k])
			n += 1
		return out
	var entries := []
	for k in d.keys():
		if n >= max_items:
			return {"$type": "Dictionary", "entries": entries, "truncated": true, "size": d.size()}
		entries.append([encode(k, 0, max_items), encode(d[k], depth - 1, max_items) if depth > 0 else _summary(d[k])])
		n += 1
	return {"$type": "Dictionary", "entries": entries}


static func is_external_resource(r: Resource) -> bool:
	var p := r.resource_path
	return not p.is_empty() and not p.contains("::")


static func _encode_object(o: Object, depth: int, max_items: int) -> Variant:
	if o == null or not is_instance_valid(o):
		return null
	if o is Resource:
		var r := o as Resource
		var cls := r.get_class()
		var s = r.get_script()
		var out := {"$type": "Resource", "class": cls}
		if s is Script and not (s as Script).get_global_name().is_empty():
			out["script_class"] = str((s as Script).get_global_name())
		if is_external_resource(r):
			out["path"] = r.resource_path
			var uid := U.uid_text(r.resource_path)
			if not uid.is_empty():
				out["uid"] = uid
			return out
		out["embedded"] = true
		if not r.resource_name.is_empty():
			out["name"] = r.resource_name
		if depth > 0 and not (r is Script):
			out["properties"] = stored_properties(r, depth - 1, max_items)
		return out
	if o is Node:
		var n := o as Node
		return {"$type": "Node", "class": n.get_class(), "name": str(n.name)}
	return {"$type": "Object", "class": o.get_class()}


## Non-default, storable properties of an object, encoded.
static func stored_properties(o: Object, depth: int = 1, max_items: int = MAX_ITEMS) -> Dictionary:
	var out := {}
	var cls := o.get_class()
	for info in o.get_property_list():
		var usage: int = info["usage"]
		if not (usage & PROPERTY_USAGE_STORAGE):
			continue
		var pname: String = info["name"]
		if pname in ["script", "resource_path", "resource_local_to_scene", "resource_name", "resource_scene_unique_id"]:
			continue
		var value = o.get(pname)
		if value == null:
			continue
		if ClassDB.class_exists(cls):
			var def = ClassDB.class_get_property_default_value(cls, pname)
			if typeof(def) == typeof(value) and typeof(value) != TYPE_OBJECT and def == value:
				continue
		out[pname] = encode(value, depth, max_items)
	return out


# ---------------------------------------------------------------- decoding

static func _is_num(x: Variant) -> bool:
	return typeof(x) == TYPE_INT or typeof(x) == TYPE_FLOAT


static func _nums(j: Variant, n: int, names: Array) -> Variant:
	if typeof(j) == TYPE_ARRAY and (j as Array).size() == n:
		for x in j:
			if not _is_num(x):
				return null
		return j
	if typeof(j) == TYPE_DICTIONARY:
		var d := j as Dictionary
		if d.has("value") and d.has("$type"):
			return _nums(d["value"], n, names)
		var out := []
		for k in names:
			if not d.has(k) or not _is_num(d[k]):
				return null
			out.append(d[k])
		return out
	return null


static func _need(what: String, j: Variant) -> Dictionary:
	return U.fail("INVALID_ARGUMENT", "Expected %s but got %s" % [what, JSON.stringify(j).left(120)])


static func _vec2(j) -> Variant:
	var a = _nums(j, 2, ["x", "y"])
	return null if a == null else Vector2(a[0], a[1])


static func _vec3(j) -> Variant:
	var a = _nums(j, 3, ["x", "y", "z"])
	return null if a == null else Vector3(a[0], a[1], a[2])


static func _basis_from(j: Variant) -> Variant:
	if typeof(j) == TYPE_ARRAY and (j as Array).size() == 3:
		var x = _vec3(j[0])
		var y = _vec3(j[1])
		var z = _vec3(j[2])
		if x != null and y != null and z != null:
			return Basis(x, y, z)
		return null
	if typeof(j) != TYPE_DICTIONARY:
		return null
	var d := j as Dictionary
	if d.has("x") and d.has("y") and d.has("z"):
		var bx = _vec3(d["x"])
		var by = _vec3(d["y"])
		var bz = _vec3(d["z"])
		if bx == null or by == null or bz == null:
			return null
		return Basis(bx, by, bz)
	var b := Basis.IDENTITY
	if d.has("rotation_degrees"):
		var r = _vec3(d["rotation_degrees"])
		if r == null:
			return null
		b = Basis.from_euler(Vector3(deg_to_rad(r.x), deg_to_rad(r.y), deg_to_rad(r.z)))
	elif d.has("rotation"):
		var rr = _vec3(d["rotation"])
		if rr == null:
			return null
		b = Basis.from_euler(rr)
	if d.has("scale"):
		var s = _vec3(d["scale"]) if typeof(d["scale"]) != TYPE_FLOAT and typeof(d["scale"]) != TYPE_INT else Vector3.ONE * float(d["scale"])
		if s == null:
			return null
		b = b * Basis.from_scale(s)
	return b


static func _color(j: Variant) -> Variant:
	if typeof(j) == TYPE_STRING:
		var s := (j as String).strip_edges()
		if Color.html_is_valid(s):
			return Color.html(s)
		var sentinel := Color(-1, -1, -1, -1)
		var c := Color.from_string(s, sentinel)
		return null if c == sentinel else c
	if typeof(j) == TYPE_ARRAY and ((j as Array).size() == 3 or (j as Array).size() == 4):
		for x in j:
			if not _is_num(x):
				return null
		return Color(j[0], j[1], j[2], j[3] if (j as Array).size() == 4 else 1.0)
	if typeof(j) == TYPE_DICTIONARY:
		var d := j as Dictionary
		if d.has("$type"):
			return _color(d.get("value"))
		if d.has("r") and d.has("g") and d.has("b"):
			return Color(float(d["r"]), float(d["g"]), float(d["b"]), float(d.get("a", 1.0)))
	return null


static func _enum_map(hint_string: String) -> Dictionary:
	var map := {}
	var next := 0
	for part in hint_string.split(","):
		var p := part.strip_edges()
		if p.is_empty():
			continue
		var name := p
		var value := next
		if p.contains(":"):
			name = p.get_slice(":", 0)
			value = int(p.get_slice(":", 1))
		map[name] = value
		next = value + 1
	return map


static func _flags_map(hint_string: String) -> Dictionary:
	var map := {}
	var bit := 1
	for part in hint_string.split(","):
		var p := part.strip_edges()
		if p.is_empty():
			continue
		var name := p
		var value := bit
		if p.contains(":"):
			name = p.get_slice(":", 0)
			value = int(p.get_slice(":", 1))
		map[name] = value
		bit = value * 2
	return map


static func _enum_lookup(map: Dictionary, name: String) -> Variant:
	var want := name.strip_edges().to_lower().replace(" ", "_")
	for k in map.keys():
		var key := str(k).to_lower().replace(" ", "_")
		if key == want or want.ends_with("_" + key) or key.ends_with("_" + want):
			return map[k]
	return null


static func _int_value(j: Variant, info: Dictionary) -> Variant:
	var hint: int = info.get("hint", PROPERTY_HINT_NONE)
	var hs: String = info.get("hint_string", "")
	if _is_num(j):
		if float(j) != floor(float(j)):
			return _need("an integer", j)
		return int(j)
	if hint == PROPERTY_HINT_ENUM and typeof(j) == TYPE_STRING:
		var v = _enum_lookup(_enum_map(hs), j)
		if v == null:
			return U.fail("INVALID_ARGUMENT", "'%s' is not one of: %s" % [j, ", ".join(_enum_map(hs).keys())])
		return v
	if hint in [PROPERTY_HINT_FLAGS, PROPERTY_HINT_LAYERS_2D_PHYSICS, PROPERTY_HINT_LAYERS_3D_PHYSICS, PROPERTY_HINT_LAYERS_2D_RENDER, PROPERTY_HINT_LAYERS_3D_RENDER, PROPERTY_HINT_LAYERS_2D_NAVIGATION, PROPERTY_HINT_LAYERS_3D_NAVIGATION, PROPERTY_HINT_LAYERS_AVOIDANCE] and typeof(j) == TYPE_ARRAY:
		# Arrays of flag names, or of 1-based layer numbers for layer masks.
		var mask := 0
		var fmap := _flags_map(hs) if hint == PROPERTY_HINT_FLAGS else {}
		for item in j:
			if _is_num(item):
				if hint == PROPERTY_HINT_FLAGS:
					mask |= int(item)
				else:
					if int(item) < 1 or int(item) > 32:
						return U.fail("INVALID_ARGUMENT", "Layer numbers are 1..32, got %s" % item)
					mask |= 1 << (int(item) - 1)
			elif typeof(item) == TYPE_STRING and hint == PROPERTY_HINT_FLAGS:
				var f = _enum_lookup(fmap, item)
				if f == null:
					return U.fail("INVALID_ARGUMENT", "'%s' is not one of: %s" % [item, ", ".join(fmap.keys())])
				mask |= int(f)
			else:
				return _need("flag names or layer numbers", item)
		return mask
	if typeof(j) == TYPE_STRING and ClassDB.class_exists(info.get("owner_class", "")):
		# Accept enum constant names such as "PROCESS_MODE_ALWAYS" via ClassDB.
		var cls: String = info["owner_class"]
		if ClassDB.class_has_integer_constant(cls, j):
			return ClassDB.class_get_integer_constant(cls, j)
	return _need("an integer" + (" or one of the enum names" if hint == PROPERTY_HINT_ENUM else ""), j)


## Parse the element type of a typed Array property.
## Returns {"type": int, "hint": int, "hint_string": String, "class_name": String} or {}.
static func array_element_info(info: Dictionary) -> Dictionary:
	var hint: int = info.get("hint", PROPERTY_HINT_NONE)
	var hs: String = info.get("hint_string", "")
	if hint == PROPERTY_HINT_ARRAY_TYPE and not hs.is_empty():
		for t in TYPE_MAX:
			if type_string(t) == hs:
				return {"type": t, "hint": PROPERTY_HINT_NONE, "hint_string": "", "class_name": ""}
		return {"type": TYPE_OBJECT, "hint": PROPERTY_HINT_RESOURCE_TYPE, "hint_string": hs, "class_name": hs}
	if hint == PROPERTY_HINT_TYPE_STRING and hs.contains(":"):
		var head := hs.get_slice(":", 0)
		var rest := hs.substr(head.length() + 1)
		var t := int(head.get_slice("/", 0))
		var h := int(head.get_slice("/", 1)) if head.contains("/") else PROPERTY_HINT_NONE
		return {"type": t, "hint": h, "hint_string": rest, "class_name": rest if t == TYPE_OBJECT else ""}
	return {}


static func _load_resource(path_json: Variant, info: Dictionary, ctx: Dictionary) -> Variant:
	var res_path = U.to_res_path(path_json)
	if U.is_fail(res_path):
		return res_path
	if not ResourceLoader.exists(res_path):
		return U.fail("NOT_FOUND", "Resource does not exist (or is not imported yet): %s" % res_path, {"path": res_path})
	if res_path == ctx.get("self_path", ""):
		return U.fail("INVALID_ARGUMENT", "A scene cannot reference itself: %s" % res_path)
	U.register_uid(res_path)
	var r = ResourceLoader.load(res_path)
	if r == null:
		return U.fail("OPERATION_FAILED", "Failed to load resource %s (see diagnostics)" % res_path, {"path": res_path})
	if r is Script and not ctx.get("allow_script", false):
		return U.fail("CLASS_NOT_ALLOWED", "Scripts cannot be assigned through properties; use the attach_script action", {"path": res_path})
	var check := _check_resource_type(r, info)
	if not check.is_empty():
		return U.fail("INVALID_ARGUMENT", check, {"path": res_path})
	return r


static func _check_resource_type(r: Resource, info: Dictionary) -> String:
	var hint: int = info.get("hint", PROPERTY_HINT_NONE)
	if hint != PROPERTY_HINT_RESOURCE_TYPE and hint != PROPERTY_HINT_NODE_TYPE:
		var cn: String = info.get("class_name", "")
		if cn.is_empty() or cn == "Resource":
			return ""
		return "" if _is_class(r, cn) else "%s is a %s, expected %s" % [r.resource_path, r.get_class(), cn]
	var allowed: String = info.get("hint_string", "")
	if allowed.is_empty():
		return ""
	for c in allowed.split(","):
		if _is_class(r, c.strip_edges()):
			return ""
	return "%s is a %s, expected one of: %s" % [r.resource_path if not r.resource_path.is_empty() else "value", r.get_class(), allowed]


static func _is_class(o: Object, cls: String) -> bool:
	if o.is_class(cls):
		return true
	var s = o.get_script()
	while s is Script:
		if str((s as Script).get_global_name()) == cls:
			return true
		s = (s as Script).get_base_script()
	return false


static func _new_resource(cls: String, props: Variant, info: Dictionary, ctx: Dictionary) -> Variant:
	var obj = P.create(cls, "Resource")
	if U.is_fail(obj):
		return obj
	var check := _check_resource_type(obj, info)
	if not check.is_empty():
		return U.fail("INVALID_ARGUMENT", "New %s: %s" % [cls, check])
	if props != null:
		if typeof(props) != TYPE_DICTIONARY:
			return _need("an object of properties", props)
		var depth: int = ctx.get("depth", 0)
		if depth > 6:
			return U.fail("INVALID_ARGUMENT", "Nested resources are too deep (max 6 levels)")
		var sub_ctx := ctx.duplicate()
		sub_ctx["depth"] = depth + 1
		for k in (props as Dictionary).keys():
			var r = set_property(obj, str(k), props[k], sub_ctx)
			if U.is_fail(r):
				var e: Dictionary = r[U.ERR_KEY]
				e["message"] = "%s.%s: %s" % [cls, k, e["message"]]
				return r
	return obj


static func _object_value(j: Variant, info: Dictionary, ctx: Dictionary) -> Variant:
	if j == null:
		return null
	var hint: int = info.get("hint", PROPERTY_HINT_NONE)
	if hint == PROPERTY_HINT_NODE_TYPE or (ClassDB.class_exists(info.get("class_name", "")) and ClassDB.is_parent_class(info.get("class_name", ""), "Node")):
		# Exported Node references: {"$type":"NodeRef","path":"../Target"} or a plain path string.
		var p = j.get("path") if typeof(j) == TYPE_DICTIONARY else j
		if typeof(p) != TYPE_STRING:
			return _need("a node path string or {\"$type\":\"NodeRef\",\"path\":...}", j)
		var base: Node = ctx.get("node")
		var root: Node = ctx.get("root")
		if base == null:
			return U.fail("INVALID_ARGUMENT", "Node references can only be set on nodes")
		var target: Node = base.get_node_or_null(NodePath(p))
		if target == null and root != null:
			target = U.find_node(root, p)
		if target == null:
			return U.fail("NOT_FOUND", "Referenced node not found: %s" % p)
		var cn: String = info.get("hint_string", "") if hint == PROPERTY_HINT_NODE_TYPE else info.get("class_name", "")
		if not cn.is_empty() and not _is_class(target, cn.get_slice(",", 0)):
			return U.fail("INVALID_ARGUMENT", "Node %s is a %s, expected %s" % [p, target.get_class(), cn])
		return target
	if typeof(j) == TYPE_STRING:
		return _load_resource(j, info, ctx)
	if typeof(j) != TYPE_DICTIONARY:
		return _need("null, a res:// path or a resource object", j)
	var d := j as Dictionary
	if d.has("$new"):
		return _new_resource(str(d["$new"]), d.get("properties"), info, ctx)
	if str(d.get("$type", "")) == "Resource":
		if d.has("path"):
			return _load_resource(d["path"], info, ctx)
		if d.has("class"):
			return _new_resource(str(d["class"]), d.get("properties"), info, ctx)
	return _need("{\"$new\":\"Class\",\"properties\":{...}} or a res:// path", j)


static func _decode_tagged(d: Dictionary, ctx: Dictionary) -> Variant:
	var t := str(d["$type"])
	var v = d.get("value")
	match t:
		"float":
			if typeof(v) == TYPE_STRING:
				match v:
					"nan": return NAN
					"inf": return INF
					"-inf": return -INF
			return float(v) if _is_num(v) else _need("a number", v)
		"int":
			return int(v) if _is_num(v) else _need("an integer", v)
		"StringName":
			return StringName(str(v))
		"NodePath":
			return NodePath(str(v))
		"Color":
			var c = _color(v)
			return c if c != null else _need("a color", v)
		"Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", "Quaternion", "Plane":
			for tt in TYPE_MAX:
				if type_string(tt) == t:
					return _typed(v, {"type": tt}, ctx)
		"Rect2", "Rect2i", "AABB", "Transform2D", "Transform3D", "Basis", "Projection":
			for tt in TYPE_MAX:
				if type_string(tt) == t:
					var payload := d.duplicate()
					payload.erase("$type")
					return _typed(payload if not d.has("value") else v, {"type": tt}, ctx)
		"Dictionary":
			var out := {}
			for e in d.get("entries", []):
				if typeof(e) != TYPE_ARRAY or (e as Array).size() != 2:
					return _need("[key, value] pairs", e)
				var k = decode(e[0], {}, ctx)
				var val = decode(e[1], {}, ctx)
				if U.is_fail(k):
					return k
				if U.is_fail(val):
					return val
				out[k] = val
			return out
		"Array":
			return decode(v, {}, ctx)
		"Resource":
			return _object_value(d, {"type": TYPE_OBJECT, "hint": PROPERTY_HINT_RESOURCE_TYPE, "hint_string": "Resource"}, ctx)
		"NodeRef":
			return U.fail("INVALID_ARGUMENT", "NodeRef values are only valid for Node-typed properties")
	if t.begins_with("Packed") and t.ends_with("Array"):
		for tt in TYPE_MAX:
			if type_string(tt) == t:
				return _typed(v, {"type": tt}, ctx)
	return U.fail("INVALID_ARGUMENT", "Unsupported $type '%s'" % t)


## Decode `j` into a Variant suitable for a property described by `info`
## (a get_property_list() entry; {} means untyped Variant).
static func decode(j: Variant, info: Dictionary = {}, ctx: Dictionary = {}) -> Variant:
	var t: int = info.get("type", TYPE_NIL)
	if typeof(j) == TYPE_DICTIONARY and (j as Dictionary).has("$type") and t != TYPE_OBJECT:
		var tagged = _decode_tagged(j, ctx)
		if U.is_fail(tagged) or t == TYPE_NIL:
			return tagged
		return _typed(tagged, info, ctx)
	if t == TYPE_NIL:
		return _untyped(j, ctx)
	return _typed(j, info, ctx)


static func _untyped(j: Variant, ctx: Dictionary) -> Variant:
	match typeof(j):
		TYPE_FLOAT:
			# JSON has a single number type; integral values become int.
			return int(j) if j == floor(j) and absf(j) < 9.0e15 else j
		TYPE_ARRAY:
			var out := []
			for item in j:
				var v = decode(item, {}, ctx)
				if U.is_fail(v):
					return v
				out.append(v)
			return out
		TYPE_DICTIONARY:
			if (j as Dictionary).has("$new"):
				return _object_value(j, {"type": TYPE_OBJECT, "hint": PROPERTY_HINT_RESOURCE_TYPE, "hint_string": "Resource"}, ctx)
			var out := {}
			for k in (j as Dictionary).keys():
				var v = decode(j[k], {}, ctx)
				if U.is_fail(v):
					return v
				out[k] = v
			return out
	return j


static func _typed(j: Variant, info: Dictionary, ctx: Dictionary) -> Variant:
	var t: int = info.get("type", TYPE_NIL)
	# Already the right Variant type (e.g. produced by a $type tag).
	if typeof(j) == t and t != TYPE_ARRAY and t != TYPE_DICTIONARY and t != TYPE_OBJECT:
		return j
	match t:
		TYPE_BOOL:
			return j if typeof(j) == TYPE_BOOL else _need("a boolean", j)
		TYPE_INT:
			return _int_value(j, info)
		TYPE_FLOAT:
			return float(j) if _is_num(j) else _need("a number", j)
		TYPE_STRING:
			return j if typeof(j) == TYPE_STRING else _need("a string", j)
		TYPE_STRING_NAME:
			return StringName(j) if typeof(j) in [TYPE_STRING, TYPE_STRING_NAME] else _need("a string", j)
		TYPE_NODE_PATH:
			return NodePath(str(j)) if typeof(j) in [TYPE_STRING, TYPE_NODE_PATH, TYPE_STRING_NAME] else _need("a node path string", j)
		TYPE_VECTOR2:
			var v = _vec2(j)
			return v if v != null else _need("[x, y]", j)
		TYPE_VECTOR2I:
			var v = _vec2(j)
			return Vector2i(v) if v != null else _need("[x, y] integers", j)
		TYPE_VECTOR3:
			var v = _vec3(j)
			return v if v != null else _need("[x, y, z]", j)
		TYPE_VECTOR3I:
			var v = _vec3(j)
			return Vector3i(v) if v != null else _need("[x, y, z] integers", j)
		TYPE_VECTOR4, TYPE_VECTOR4I:
			var a = _nums(j, 4, ["x", "y", "z", "w"])
			if a == null:
				return _need("[x, y, z, w]", j)
			return Vector4(a[0], a[1], a[2], a[3]) if t == TYPE_VECTOR4 else Vector4i(a[0], a[1], a[2], a[3])
		TYPE_QUATERNION:
			if typeof(j) == TYPE_DICTIONARY and (j as Dictionary).has("euler_degrees"):
				var e = _vec3(j["euler_degrees"])
				if e == null:
					return _need("euler_degrees [x, y, z]", j)
				return Quaternion.from_euler(Vector3(deg_to_rad(e.x), deg_to_rad(e.y), deg_to_rad(e.z)))
			var a = _nums(j, 4, ["x", "y", "z", "w"])
			return Quaternion(a[0], a[1], a[2], a[3]) if a != null else _need("[x, y, z, w]", j)
		TYPE_PLANE:
			var a = _nums(j, 4, ["a", "b", "c", "d"])
			return Plane(a[0], a[1], a[2], a[3]) if a != null else _need("[a, b, c, d]", j)
		TYPE_COLOR:
			var c = _color(j)
			return c if c != null else _need("a color ('#rrggbb', a name, [r,g,b(,a)] or {r,g,b,a})", j)
		TYPE_RECT2, TYPE_RECT2I:
			var r: Rect2
			if typeof(j) == TYPE_ARRAY and (j as Array).size() == 4:
				var a = _nums(j, 4, [])
				if a == null:
					return _need("[x, y, w, h]", j)
				r = Rect2(a[0], a[1], a[2], a[3])
			elif typeof(j) == TYPE_DICTIONARY and (j as Dictionary).has("position") and (j as Dictionary).has("size"):
				var p = _vec2(j["position"])
				var s = _vec2(j["size"])
				if p == null or s == null:
					return _need("{position:[x,y], size:[w,h]}", j)
				r = Rect2(p, s)
			else:
				return _need("[x, y, w, h] or {position, size}", j)
			return r if t == TYPE_RECT2 else Rect2i(r)
		TYPE_AABB:
			if typeof(j) == TYPE_DICTIONARY and (j as Dictionary).has("position") and (j as Dictionary).has("size"):
				var p = _vec3(j["position"])
				var s = _vec3(j["size"])
				if p != null and s != null:
					return AABB(p, s)
			return _need("{position:[x,y,z], size:[x,y,z]}", j)
		TYPE_TRANSFORM2D:
			if typeof(j) != TYPE_DICTIONARY:
				return _need("{origin, rotation_degrees, scale} or {x, y, origin}", j)
			var d := j as Dictionary
			if d.has("x") and d.has("y"):
				var x = _vec2(d["x"])
				var y = _vec2(d["y"])
				var o = _vec2(d.get("origin", [0, 0]))
				if x == null or y == null or o == null:
					return _need("Transform2D columns", j)
				return Transform2D(x, y, o)
			var pos = _vec2(d.get("origin", d.get("position", [0, 0])))
			var sc = _vec2(d.get("scale", [1, 1]))
			if pos == null or sc == null:
				return _need("{origin:[x,y], rotation_degrees, scale:[x,y]}", j)
			var rot := deg_to_rad(float(d.get("rotation_degrees", 0.0))) if d.has("rotation_degrees") else float(d.get("rotation", 0.0))
			return Transform2D(rot, sc, float(d.get("skew", 0.0)), pos)
		TYPE_BASIS:
			var b = _basis_from(j)
			return b if b != null else _need("{x,y,z} columns or {rotation_degrees, scale}", j)
		TYPE_TRANSFORM3D:
			if typeof(j) != TYPE_DICTIONARY:
				return _need("{origin:[x,y,z], rotation_degrees:[x,y,z], scale:[x,y,z]} or {basis, origin}", j)
			var d := j as Dictionary
			var origin = _vec3(d.get("origin", d.get("position", [0, 0, 0])))
			if origin == null:
				return _need("origin [x, y, z]", j)
			var basis = _basis_from(d["basis"]) if d.has("basis") else _basis_from(d)
			if basis == null:
				return _need("a basis", j)
			return Transform3D(basis, origin)
		TYPE_PROJECTION:
			if typeof(j) == TYPE_ARRAY and (j as Array).size() == 4:
				var cols := []
				for c in j:
					var a = _nums(c, 4, [])
					if a == null:
						return _need("4x4 numbers", j)
					cols.append(Vector4(a[0], a[1], a[2], a[3]))
				return Projection(cols[0], cols[1], cols[2], cols[3])
			return _need("4x4 numbers", j)
		TYPE_DICTIONARY:
			if typeof(j) == TYPE_DICTIONARY:
				return _untyped(j, ctx)
			return _need("an object", j)
		TYPE_ARRAY:
			return _array_value(j, info, ctx)
		TYPE_OBJECT:
			return _object_value(j, info, ctx)
		TYPE_CALLABLE, TYPE_SIGNAL, TYPE_RID:
			return U.fail("INVALID_ARGUMENT", "%s values cannot be set through MCP" % type_string(t))
	if t >= TYPE_PACKED_BYTE_ARRAY and t <= TYPE_PACKED_VECTOR4_ARRAY:
		return _packed_value(j, t, ctx)
	return _need(type_string(t), j)


static func _array_value(j: Variant, info: Dictionary, ctx: Dictionary) -> Variant:
	if typeof(j) == TYPE_DICTIONARY and (j as Dictionary).has("value"):
		j = j["value"]
	if typeof(j) != TYPE_ARRAY:
		return _need("an array", j)
	if (j as Array).size() > 100000:
		return U.fail("INVALID_ARGUMENT", "Array too large (max 100000 elements)")
	var elem := array_element_info(info)
	var out := []
	for item in j:
		var v = decode(item, elem, ctx)
		if U.is_fail(v):
			return v
		out.append(v)
	if elem.is_empty():
		return out
	var et: int = elem["type"]
	var ecls := StringName(elem.get("class_name", "")) if et == TYPE_OBJECT else &""
	if et == TYPE_OBJECT and not ClassDB.class_exists(ecls):
		ecls = &"Resource"
	return Array(out, et, ecls, null)


static func _packed_value(j: Variant, t: int, ctx: Dictionary) -> Variant:
	if typeof(j) == TYPE_DICTIONARY and (j as Dictionary).has("value"):
		j = j["value"]
	if typeof(j) != TYPE_ARRAY:
		return _need("an array for " + type_string(t), j)
	var elem_type := TYPE_NIL
	match t:
		TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY: elem_type = TYPE_INT
		TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY: elem_type = TYPE_FLOAT
		TYPE_PACKED_STRING_ARRAY: elem_type = TYPE_STRING
		TYPE_PACKED_VECTOR2_ARRAY: elem_type = TYPE_VECTOR2
		TYPE_PACKED_VECTOR3_ARRAY: elem_type = TYPE_VECTOR3
		TYPE_PACKED_VECTOR4_ARRAY: elem_type = TYPE_VECTOR4
		TYPE_PACKED_COLOR_ARRAY: elem_type = TYPE_COLOR
	var items := []
	for item in j:
		var v = _typed(item, {"type": elem_type}, ctx)
		if U.is_fail(v):
			return v
		items.append(v)
	return type_convert(items, t)


# ---------------------------------------------------------------- properties

static func property_info(o: Object, name: String) -> Dictionary:
	for info in o.get_property_list():
		if str(info["name"]) == name:
			var d: Dictionary = info.duplicate()
			d["owner_class"] = o.get_class()
			return d
	return {}


static func suggest(o: Object, name: String, limit: int = 5) -> Array:
	var scored := []
	for info in o.get_property_list():
		var n := str(info["name"])
		if not (int(info["usage"]) & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)):
			continue
		var s := n.similarity(name)
		if n.contains(name) or name.contains(n):
			s += 0.5
		scored.append([s, n])
	scored.sort_custom(func(a, b): return a[0] > b[0])
	var out := []
	for i in mini(limit, scored.size()):
		if scored[i][0] > 0.3:
			out.append(scored[i][1])
	return out


## Resolve "a:b:c" sub-property paths. Returns [target_object, final_name] or fail().
static func resolve_target(o: Object, path: String) -> Variant:
	var parts := path.split(":")
	var target: Object = o
	for i in parts.size() - 1:
		var sub = target.get(parts[i])
		if typeof(sub) != TYPE_OBJECT or sub == null:
			return U.fail("NOT_FOUND", "'%s' is not an object-valued property on %s" % [parts[i], target.get_class()])
		if sub is Resource and is_external_resource(sub):
			return U.fail("CONFLICT", "'%s' refers to the external resource %s; edit that file with godot_resource_edit instead of changing it through this node" % [parts[i], sub.resource_path], {"path": sub.resource_path})
		if sub is Node:
			return U.fail("INVALID_ARGUMENT", "Sub-property paths cannot traverse nodes ('%s')" % parts[i])
		target = sub
	return [target, parts[parts.size() - 1]]


## Validated property assignment. Returns {"property", "value"} or fail().
static func set_property(o: Object, path: String, j: Variant, ctx: Dictionary = {}) -> Variant:
	if path.is_empty():
		return U.fail("INVALID_ARGUMENT", "Property name must not be empty")
	var resolved = resolve_target(o, path)
	if U.is_fail(resolved):
		return resolved
	var target: Object = resolved[0]
	var name: String = resolved[1]
	if name in FORBIDDEN_PROPERTIES and not (name == "script" and ctx.get("allow_script", false)):
		return U.fail("INVALID_ARGUMENT", "Property '%s' cannot be set directly; use the dedicated action (attach_script, rename_node, ...)" % name)
	var info := property_info(target, name)
	if info.is_empty():
		return U.fail("NOT_FOUND", "%s has no property '%s'" % [target.get_class(), name], {"suggestions": suggest(target, name)})
	var usage: int = info["usage"]
	if name.begins_with("_") or (usage & PROPERTY_USAGE_INTERNAL):
		return U.fail("INVALID_ARGUMENT", "Property '%s' is internal and cannot be set" % name)
	if usage & PROPERTY_USAGE_READ_ONLY:
		return U.fail("INVALID_ARGUMENT", "Property '%s' is read-only" % name)
	var value = decode(j, info, ctx)
	if U.is_fail(value):
		var e: Dictionary = value[U.ERR_KEY]
		e["message"] = "%s: %s" % [path, e["message"]]
		return value
	target.set(name, value)
	var after = target.get(name)
	if typeof(after) != typeof(value) and not (value == null and typeof(after) == TYPE_OBJECT):
		return U.fail("OPERATION_FAILED", "Godot did not accept the value for '%s' (expected %s)" % [path, type_string(int(info["type"]))])
	if typeof(value) == TYPE_OBJECT and after != value:
		return U.fail("OPERATION_FAILED", "Godot did not accept the object assigned to '%s'" % path)
	return {"property": path, "value": encode(after, 1)}
