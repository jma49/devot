#!/usr/bin/env bash
# Usage: readme-clips.sh <frames-dir> [<out-dir>]
#
# Builds the README's animated WebP clips in docs/images/ (or <out-dir>) from the website's
# 2x frames: <frames-dir>/<slot>/<light|dark>/00000.png, 30 fps. Needs ffmpeg and img2webp.
# Every clip gets rounded corners and a hairline edge (black at 12% on light, white at 10% on
# dark) over a transparent outside, so it stands out on GitHub's light and dark pages.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <frames-dir> [<out-dir>]" >&2; exit 2; }
frames=$1
out=${2:-docs/images}
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

FPS=15
DELAY=67
QUALITY=90
ROW_WIDTH=1600
ROW_HEIGHT=656
GAP=24

# rounded_edge <variant> <width>: radius 16 px and edge 2 px at the 1600 px row size, scaled to <width>.
rounded_edge() {
  local variant=$1 width=$2 r b
  r=$(awk "BEGIN { print 16 * $width / $ROW_WIDTH }")
  b=$(awk "BEGIN { print 2 * $width / $ROW_WIDTH }")
  local dx="max(0,max($r-X-0.5,X+0.5-(W-$r)))"
  local dy="max(0,max($r-Y-0.5,Y+0.5-(H-$r)))"
  local depth="min(min(min(X+0.5,W-X-0.5),min(Y+0.5,H-Y-0.5)),$r-hypot($dx,$dy))"
  local edge="clip($b-$depth+0.5,0,1)"
  local rgb
  if [ "$variant" = dark ]; then
    rgb="r='r(X,Y)+(255-r(X,Y))*0.10*$edge':g='g(X,Y)+(255-g(X,Y))*0.10*$edge':b='b(X,Y)+(255-b(X,Y))*0.10*$edge'"
  else
    rgb="r='r(X,Y)*(1-0.12*$edge)':g='g(X,Y)*(1-0.12*$edge)':b='b(X,Y)*(1-0.12*$edge)'"
  fi
  echo "format=rgba,geq=$rgb:a='255*clip($depth+0.5,0,1)'"
}

count() { find "$frames/$1/$2" -name '*.png' | wc -l | tr -d ' '; }

encode() {
  local dir=$1 target=$2
  img2webp -loop 0 -lossy -q "$QUALITY" -m 6 -d "$DELAY" "$dir"/*.png -o "$target" > /dev/null
}

# single <slot> <width> <variant> <target>
single() {
  local slot=$1 width=$2 variant=$3 target=$4 dir="$work/$1-$3"
  mkdir -p "$dir"
  ffmpeg -v error -threads 4 -framerate 30 -i "$frames/$slot/$variant/%05d.png" \
    -vf "fps=$FPS,scale=$width:-2:flags=lanczos,$(rounded_edge "$variant" "$width")" "$dir/%04d.png"
  encode "$dir" "$target"
  rm -rf "$dir"
}

# row <name> <left-slot> <left-width> <right-slot> <right-width> <variant> <target>
# Both clips start together; the shorter one holds its last frame until the longer one ends.
row() {
  local left=$2 lw=$3 right=$4 rw=$5 variant=$6 target=$7 dir="$work/$1-$6"
  local nl nr total
  nl=$(( ($(count "$left" "$variant") + 1) / 2 ))
  nr=$(( ($(count "$right" "$variant") + 1) / 2 ))
  total=$(( nl > nr ? nl : nr ))
  mkdir -p "$dir"
  ffmpeg -v error -threads 4 \
    -framerate 30 -i "$frames/$left/$variant/%05d.png" \
    -framerate 30 -i "$frames/$right/$variant/%05d.png" \
    -f lavfi -i "color=c=black@0:s=${ROW_WIDTH}x${ROW_HEIGHT},format=rgba" \
    -filter_complex "[0:v]fps=$FPS,scale=$lw:$ROW_HEIGHT:flags=lanczos,$(rounded_edge "$variant" "$ROW_WIDTH"),tpad=stop_mode=clone:stop=$total[a];\
[1:v]fps=$FPS,scale=$rw:$ROW_HEIGHT:flags=lanczos,$(rounded_edge "$variant" "$ROW_WIDTH"),tpad=stop_mode=clone:stop=$total[b];\
[2:v][a]overlay=0:0:format=auto[c];[c][b]overlay=$((lw + GAP)):0:format=auto,format=rgba[o]" \
    -map "[o]" -frames:v "$total" "$dir/%04d.png"
  encode "$dir" "$target"
  rm -rf "$dir"
}

for variant in light dark; do
  suffix=""
  [ "$variant" = dark ] && suffix="-dark"
  single hero 1280 "$variant" "$out/hero$suffix.webp"
  for slot in write organise find; do
    single "$slot" 800 "$variant" "$out/$slot$suffix.webp"
  done
  row cards-1 card-1 1050 card-2 525 "$variant" "$out/cards-1$suffix.webp"
  row cards-2 card-3 525 card-4 1050 "$variant" "$out/cards-2$suffix.webp"
  row cards-3 card-5 1050 card-6 525 "$variant" "$out/cards-3$suffix.webp"
done
