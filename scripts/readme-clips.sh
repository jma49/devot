#!/usr/bin/env bash
# Usage: readme-clips.sh <frames-dir> [<out-dir>]
#
# Builds the README's animated WebP clips in docs/images/ (or <out-dir>) from the website's
# 2x frames: <frames-dir>/<slot>/<light|dark>/00000.png, 30 fps. Needs img2webp, webpmux, ffprobe
# and an ffmpeg that reads animated WebP.
# Every clip gets rounded corners and a hairline edge (black at 12% on light, white at 10% on
# dark) over a transparent outside, so it stands out on GitHub's light and dark pages.
# Clips are only scaled uniformly: after writing a file the script measures every clip in it and
# stops if one's aspect ratio is more than 0.5% off its source's, if the file does not play for
# as long as its source, or if a clip's last frame is not its source's last frame.
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
GAP=24
TOLERANCE=0.005

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

# Wide card frames reach below the card for the website's phone cut. The website shows their top
# 1312x820 from the frame's origin (frameRect and CUTS.wide.clip in jma49/devot-site
# scripts/media/scenes.ts, inFrame in scripts/media/capture.ts); so does the README.
crop_of() {
  case $1 in
    card-1 | card-4 | card-5) echo 1312:820:0:0 ;;
  esac
}

crop_filter() {
  local crop
  crop=$(crop_of "$1")
  [ -z "$crop" ] || echo "crop=$crop,"
}

# source_size <slot> <variant>: "<width> <height>" of what the clip shows, after any crop.
source_size() {
  local crop
  crop=$(crop_of "$1")
  if [ -n "$crop" ]; then
    echo "$crop" | awk -F: '{ print $1, $2 }'
  else
    ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x \
      "$frames/$1/$2/00000.png" | tr x ' '
  fi
}

count() { find "$frames/$1/$2" -name '*.png' | wc -l | tr -d ' '; }

encode() {
  local dir=$1 target=$2
  img2webp -loop 0 -lossy -q "$QUALITY" -m 6 -d "$DELAY" "$dir"/*.png -o "$target" > /dev/null
}

# measure <file> <x> <width>: "<width> <height>" of the opaque part of the first frame of <file>
# within the <width> columns from <x>. It crops the alpha plane: cropping the decoded yuva420p frame
# would round odd sizes down to even ones.
measure() {
  ffmpeg -nostats -v info -threads 4 -i "$1" -frames:v 1 -filter_threads 4 \
    -vf "alphaextract,crop=$3:ih:$2:0,bbox=min_val=127" -f null - 2>&1 |
    sed -n 's/.* w:\([0-9]*\) h:\([0-9]*\) .*/\1 \2/p' | head -n 1
}

# check <file> <slot> <variant> <x> <width>: stops unless the clip of <slot> drawn in those columns
# of <file> keeps the aspect ratio of its source.
check() {
  local file=$1 slot=$2 variant=$3 got name
  name=$(basename "$file")
  got=$(measure "$file" "$4" "$5")
  [ -n "$got" ] || { echo "E_CLIP_MEASURE $name $slot" >&2; exit 1; }
  awk -v got="$got" -v src="$(source_size "$slot" "$variant")" -v tol="$TOLERANCE" \
    -v name="$name" -v slot="$slot" 'BEGIN {
    split(got, g, " "); split(src, s, " ")
    off = (g[1] / g[2]) / (s[1] / s[2]) - 1
    printf "%s %s: %dx%d, source %dx%d, ratio %+.2f%%\n", name, slot, g[1], g[2], s[1], s[2], off * 100
    if (off > tol || off < -tol) { print "E_CLIP_RATIO " name " " slot > "/dev/stderr"; exit 1 }
  }'
}

# check_length <file> <frames>: stops unless <file> plays for <frames> ticks of DELAY ms.
check_length() {
  local name ms
  name=$(basename "$1")
  ms=$(webpmux -info "$1" | awk '$1 ~ /^[0-9]+:$/ { sum += $7 } END { print sum }')
  [ "$ms" -eq $(($2 * DELAY)) ] || {
    echo "E_CLIP_LENGTH $name: $ms ms, expected $(($2 * DELAY)) ms" >&2
    exit 1
  }
}

# check_end <png> <slot> <variant> <x> <width> <height>: stops unless the clip drawn at column <x>
# of <png>, the last frame written, matches its source's last frame (PSNR of the inside, away from
# the rounded edge, at least 30 dB), so the clip plays to its end at full speed.
check_end() {
  local png=$1 slot=$2 variant=$3 x=$4 width=$5 height=$6 last psnr
  last=$(find "$frames/$slot/$variant" -name '*.png' | sort | tail -n 1)
  psnr=$(ffmpeg -nostats -v info -threads 4 -i "$png" -i "$last" -filter_complex \
    "[0:v]crop=$((width - 16)):$((height - 16)):$((x + 8)):8,format=rgb24[a];\
[1:v]$(crop_filter "$slot")scale=$width:$height:flags=lanczos,crop=$((width - 16)):$((height - 16)):8:8,format=rgb24[b];\
[a][b]psnr" -f null - 2>&1 | sed -n 's/.*average:\([0-9.inf]*\).*/\1/p' | tail -n 1)
  echo "$(basename "$png") $slot: last frame PSNR $psnr dB"
  awk -v p="$psnr" 'BEGIN { exit !(p == "inf" || p + 0 >= 30) }' || {
    echo "E_CLIP_END $slot $variant: last frame PSNR ${psnr:-unknown} dB" >&2
    exit 1
  }
}

# single <slot> <width> <variant> <target>
single() {
  local slot=$1 width=$2 variant=$3 target=$4 dir="$work/$1-$3" sw sh height
  read -r sw sh <<< "$(source_size "$slot" "$variant")"
  height=$(awk "BEGIN { printf \"%d\", $width * $sh / $sw + 0.5 }")
  mkdir -p "$dir"
  ffmpeg -v error -threads 4 -framerate 30 -i "$frames/$slot/$variant/%05d.png" -filter_threads 4 \
    -vf "fps=$FPS,$(crop_filter "$slot")scale=$width:$height:flags=lanczos,$(rounded_edge "$variant" "$width")" \
    -threads 4 "$dir/%04d.png"
  encode "$dir" "$target"
  check_length "$target" "$(find "$dir" -name '*.png' | wc -l | tr -d ' ')"
  check_end "$(find "$dir" -name '*.png' | sort | tail -n 1)" "$slot" "$variant" 0 "$width" "$height"
  rm -rf "$dir"
  check "$target" "$slot" "$variant" 0 "$width"
}

# row <name> <left-slot> <right-slot> <variant> <target>
# Both clips get the largest height at which they and the gap fit in ROW_WIDTH, each scaled
# uniformly. Both start together; the shorter one holds its last frame until the longer one ends.
row() {
  local left=$2 right=$3 variant=$4 target=$5 dir="$work/$1-$4"
  local lsw lsh rsw rsh height lw rw nl nr total
  read -r lsw lsh <<< "$(source_size "$left" "$variant")"
  read -r rsw rsh <<< "$(source_size "$right" "$variant")"
  read -r height lw rw <<< "$(awk "BEGIN {
    l = $lsw / $lsh; r = $rsw / $rsh; h = int(($ROW_WIDTH - $GAP) / (l + r))
    printf \"%d %d %d\", h, h * l + 0.5, h * r + 0.5
  }")"
  nl=$(( ($(count "$left" "$variant") + 1) / 2 ))
  nr=$(( ($(count "$right" "$variant") + 1) / 2 ))
  total=$(( nl > nr ? nl : nr ))
  mkdir -p "$dir"
  ffmpeg -v error -threads 4 -filter_complex_threads 4 \
    -framerate 30 -i "$frames/$left/$variant/%05d.png" \
    -framerate 30 -i "$frames/$right/$variant/%05d.png" \
    -f lavfi -i "color=c=black@0:s=$((lw + GAP + rw))x$height:r=$FPS,format=rgba" \
    -filter_complex "[0:v]fps=$FPS,$(crop_filter "$left")scale=$lw:$height:flags=lanczos,$(rounded_edge "$variant" "$ROW_WIDTH"),tpad=stop_mode=clone:stop=${total}[a];\
[1:v]fps=$FPS,$(crop_filter "$right")scale=$rw:$height:flags=lanczos,$(rounded_edge "$variant" "$ROW_WIDTH"),tpad=stop_mode=clone:stop=${total}[b];\
[2:v][a]overlay=0:0:format=auto[c];[c][b]overlay=$((lw + GAP)):0:format=auto,format=rgba[o]" \
    -map "[o]" -frames:v "$total" -threads 4 "$dir/%04d.png"
  encode "$dir" "$target"
  check_length "$target" "$total"
  check_end "$(find "$dir" -name '*.png' | sort | tail -n 1)" "$left" "$variant" 0 "$lw" "$height"
  check_end "$(find "$dir" -name '*.png' | sort | tail -n 1)" "$right" "$variant" $((lw + GAP)) "$rw" "$height"
  rm -rf "$dir"
  check "$target" "$left" "$variant" 0 $((lw + GAP / 2))
  check "$target" "$right" "$variant" $((lw + GAP / 2)) $((rw + GAP - GAP / 2))
}

for variant in light dark; do
  suffix=""
  [ "$variant" = dark ] && suffix="-dark"
  single hero 1280 "$variant" "$out/hero$suffix.webp"
  for slot in write organise find; do
    single "$slot" 800 "$variant" "$out/$slot$suffix.webp"
  done
  row cards-1 card-1 card-2 "$variant" "$out/cards-1$suffix.webp"
  row cards-2 card-3 card-4 "$variant" "$out/cards-2$suffix.webp"
  row cards-3 card-5 card-6 "$variant" "$out/cards-3$suffix.webp"
done
