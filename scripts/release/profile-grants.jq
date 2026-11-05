# The entitlements in the input (a property list as JSON) that the profile's ($granted[0]) do not
# grant, sorted and joined by spaces. A profile grants a string value as itself, as "*", or by a
# "<prefix>.*" wildcard; an array value needs each element granted.
def grants($p; $v):
  if ($p | type) == "array" then any($p[]; grants(.; $v))
  elif ($p | type) == "string" and ($v | type) == "string" then
    $p == $v or $p == "*" or (($p | endswith(".*")) and ($v | startswith($p[:-1])))
  else $p == $v end;
($granted[0]) as $g
| [to_entries[]
  | select(.key as $k | .value as $v
      | ($g | has($k) | not)
        or (if ($v | type) == "array" then any($v[]; grants($g[$k]; .) | not)
            else grants($g[$k]; $v) | not end))
  | .key]
| sort | join(" ")
