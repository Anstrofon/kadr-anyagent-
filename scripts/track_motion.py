#!/usr/bin/env python3
"""
Motion Tracker for Kadr video editor.
Tracks an object across video frames using Lucas-Kanade Optical Flow,
Template Matching, or OpenCV Tracker (MIL), generating keyframe coordinates
for transform.x, transform.y and scale.

Outputs JSON lines to stdout:
{"type": "init", "fps": 30.0, "width": 1920, "height": 1080, "total_frames": 150}
{"type": "progress", "frame": 10, "total": 150, "percent": 6.7, "time": 0.333, "nx": 0.5, "ny": 0.4, "nw": 0.1, "nh": 0.1}
{"type": "done", "keyframes": [...]}
"""

import sys
import os
import json
import argparse
import numpy as np

try:
    import cv2
except ImportError:
    print(json.dumps({"type": "error", "message": "OpenCV (cv2) is not installed."}), flush=True)
    sys.exit(1)


def parse_args():
    parser = argparse.ArgumentParser(description="Kadr Motion Tracker")
    parser.add_argument("--video", required=True, help="Path to video file")
    parser.add_argument("--start", type=float, default=0.0, help="Start time in seconds")
    parser.add_argument("--end", type=float, default=-1.0, help="End time in seconds (-1 for end of clip)")
    parser.add_argument("--fps", type=float, default=0.0, help="Target FPS (0 to use video native FPS)")
    # box format: nx,ny,nw,nh (normalized 0..1 relative to video width/height)
    parser.add_argument("--box", required=True, help="Initial bounding box: nx,ny,nw,nh (0..1)")
    # method: 'lk' (Lucas-Kanade point flow), 'template' (Template Matching), 'mil' (OpenCV TrackerMIL)
    parser.add_argument("--method", default="lk", choices=["lk", "template", "mil"], help="Tracking method")
    return parser.parse_args()


class LucasKanadeTracker:
    def __init__(self, first_frame_gray, bbox_px):
        x, y, w, h = bbox_px
        self.w = float(max(10, w))
        self.h = float(max(10, h))
        self.cx = float(x + w / 2.0)
        self.cy = float(y + h / 2.0)
        self.prev_gray = first_frame_gray.copy()
        self.initial_w = self.w
        self.initial_h = self.h
        self.lk_params = dict(
            winSize=(21, 21),
            maxLevel=3,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01)
        )
        self.points = self._detect_points(first_frame_gray)

    def _detect_points(self, gray):
        H, W = gray.shape
        x0 = int(max(0, self.cx - self.w / 2.0))
        y0 = int(max(0, self.cy - self.h / 2.0))
        x1 = int(min(W, self.cx + self.w / 2.0))
        y1 = int(min(H, self.cy + self.h / 2.0))

        if x1 <= x0 + 4 or y1 <= y0 + 4:
            return None

        mask = np.zeros_like(gray)
        mask[y0:y1, x0:x1] = 255

        pts = cv2.goodFeaturesToTrack(gray, maxCorners=60, qualityLevel=0.01, minDistance=4, mask=mask)
        if pts is None or len(pts) < 5:
            # Fall back to dense grid
            gx, gy = np.meshgrid(
                np.linspace(x0 + 2, x1 - 2, 6),
                np.linspace(y0 + 2, y1 - 2, 6)
            )
            pts = np.vstack([gx.ravel(), gy.ravel()]).T.reshape(-1, 1, 2).astype(np.float32)
        return pts

    def update(self, curr_gray):
        if self.points is None or len(self.points) < 3:
            self.points = self._detect_points(self.prev_gray)
            if self.points is None or len(self.points) < 2:
                self.prev_gray = curr_gray.copy()
                return False, (self.cx - self.w / 2, self.cy - self.h / 2, self.w, self.h)

        p1, st1, _ = cv2.calcOpticalFlowPyrLK(self.prev_gray, curr_gray, self.points, None, **self.lk_params)
        if p1 is None or st1 is None:
            self.prev_gray = curr_gray.copy()
            return False, (self.cx - self.w / 2, self.cy - self.h / 2, self.w, self.h)

        # Forward-backward consistency check
        p0_back, st0, _ = cv2.calcOpticalFlowPyrLK(curr_gray, self.prev_gray, p1, None, **self.lk_params)
        good_curr = []
        shifts = []
        for i in range(len(self.points)):
            if st1[i][0] == 1 and st0[i][0] == 1:
                dist = np.linalg.norm(self.points[i] - p0_back[i])
                if dist < 1.5:
                    good_curr.append(p1[i])
                    shifts.append(p1[i][0] - self.points[i][0])

        if len(shifts) >= 2:
            dx = float(np.median([s[0] for s in shifts]))
            dy = float(np.median([s[1] for s in shifts]))
            self.cx += dx
            self.cy += dy
            self.points = np.array(good_curr, dtype=np.float32)

            # Re-seed if points fell below threshold
            if len(self.points) < 8:
                new_pts = self._detect_points(curr_gray)
                if new_pts is not None and len(new_pts) > 0:
                    self.points = np.vstack([self.points, new_pts])

            self.prev_gray = curr_gray.copy()
            return True, (self.cx - self.w / 2, self.cy - self.h / 2, self.w, self.h)

        self.prev_gray = curr_gray.copy()
        return False, (self.cx - self.w / 2, self.cy - self.h / 2, self.w, self.h)


class TemplateTracker:
    def __init__(self, first_frame_gray, bbox_px):
        x, y, w, h = bbox_px
        self.w = float(max(10, w))
        self.h = float(max(10, h))
        self.cx = float(x + w / 2.0)
        self.cy = float(y + h / 2.0)
        x0 = int(max(0, x))
        y0 = int(max(0, y))
        x1 = int(min(first_frame_gray.shape[1], x + w))
        y1 = int(min(first_frame_gray.shape[0], y + h))
        self.template = first_frame_gray[y0:y1, x0:x1].copy()

    def update(self, curr_gray):
        H, W = curr_gray.shape
        # Search area: 2.5x the bbox around current center
        sw = int(self.w * 2.5)
        sh = int(self.h * 2.5)
        sx0 = max(0, int(self.cx - sw / 2.0))
        sy0 = max(0, int(self.cy - sh / 2.0))
        sx1 = min(W, int(self.cx + sw / 2.0))
        sy1 = min(H, int(self.cy + sh / 2.0))

        if sx1 - sx0 <= self.template.shape[1] or sy1 - sy0 <= self.template.shape[0]:
            return False, (self.cx - self.w / 2, self.cy - self.h / 2, self.w, self.h)

        search_roi = curr_gray[sy0:sy1, sx0:sx1]
        res = cv2.matchTemplate(search_roi, self.template, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(res)

        if max_val > 0.35:
            new_x = sx0 + max_loc[0]
            new_y = sy0 + max_loc[1]
            self.cx = new_x + self.w / 2.0
            self.cy = new_y + self.h / 2.0
            return True, (new_x, new_y, self.w, self.h)
        return False, (self.cx - self.w / 2, self.cy - self.h / 2, self.w, self.h)


def run_tracker():
    args = parse_args()
    if not os.path.isfile(args.video):
        print(json.dumps({"type": "error", "message": f"Video file not found: {args.video}"}), flush=True)
        sys.exit(1)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(json.dumps({"type": "error", "message": f"Failed to open video: {args.video}"}), flush=True)
        sys.exit(1)

    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    video_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    video_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)
    video_frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    video_duration = video_frame_count / video_fps if video_fps > 0 else 0.0

    start_sec = max(0.0, args.start)
    end_sec = args.end if args.end > start_sec else video_duration
    if end_sec <= start_sec:
        end_sec = start_sec + 5.0

    track_fps = args.fps if args.fps > 0 else video_fps
    total_frames = max(1, int(round((end_sec - start_sec) * track_fps)))

    # Parse initial bbox (normalized 0..1)
    try:
        parts = [float(p.strip()) for p in args.box.split(",")]
        nx, ny, nw, nh = parts[0], parts[1], parts[2], parts[3]
    except Exception as e:
        print(json.dumps({"type": "error", "message": f"Invalid box format: {args.box}. Expected nx,ny,nw,nh"}), flush=True)
        sys.exit(1)

    # Pixel bbox in video coordinates
    bx = int(round(nx * video_w))
    by = int(round(ny * video_h))
    bw = int(round(nw * video_w))
    bh = int(round(nh * video_h))

    bx = max(0, min(video_w - 5, bx))
    by = max(0, min(video_h - 5, by))
    bw = max(5, min(video_w - bx, bw))
    bh = max(5, min(video_h - by, bh))

    # Seek to start
    start_frame_idx = int(round(start_sec * video_fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame_idx)
    ret, first_frame = cap.read()
    if not ret or first_frame is None:
        # Fall back to POS_MSEC
        cap.set(cv2.CAP_PROP_POS_MSEC, start_sec * 1000.0)
        ret, first_frame = cap.read()

    if not ret or first_frame is None:
        print(json.dumps({"type": "error", "message": f"Failed to read frame at {start_sec}s"}), flush=True)
        sys.exit(1)

    first_gray = cv2.cvtColor(first_frame, cv2.COLOR_BGR2GRAY)

    if args.method == "lk":
        tracker = LucasKanadeTracker(first_gray, (bx, by, bw, bh))
    elif args.method == "mil":
        try:
            tracker = cv2.TrackerMIL_create()
            tracker.init(first_frame, (bx, by, bw, bh))
        except Exception:
            tracker = LucasKanadeTracker(first_gray, (bx, by, bw, bh))
    else:
        tracker = TemplateTracker(first_gray, (bx, by, bw, bh))

    print(json.dumps({
        "type": "init",
        "fps": track_fps,
        "width": video_w,
        "height": video_h,
        "total_frames": total_frames,
        "start_sec": start_sec,
        "end_sec": end_sec
    }), flush=True)

    keyframes = []
    init_cx = (bx + bw / 2.0) / video_w
    init_cy = (by + bh / 2.0) / video_h
    init_nw = bw / video_w
    init_nh = bh / video_h

    keyframes.append({
        "frame": 0,
        "time": 0.0,
        "absTime": round(start_sec, 4),
        "nx": round(init_cx, 5),
        "ny": round(init_cy, 5),
        "nw": round(init_nw, 5),
        "nh": round(init_nh, 5),
        "confidence": 1.0
    })

    last_bbox = (bx, by, bw, bh)

    for i in range(1, total_frames):
        # Sequential read!
        ret, frame = cap.read()
        if not ret or frame is None:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        ok = False
        if args.method == "mil" and hasattr(tracker, "update") and not isinstance(tracker, (LucasKanadeTracker, TemplateTracker)):
            ok, bbox = tracker.update(frame)
        else:
            ok, bbox = tracker.update(gray)

        if ok and bbox[2] > 2 and bbox[3] > 2:
            last_bbox = bbox
            conf = 1.0
        else:
            bbox = last_bbox
            conf = 0.5

        cx = (bbox[0] + bbox[2] / 2.0) / video_w
        cy = (bbox[1] + bbox[3] / 2.0) / video_h
        nw = bbox[2] / video_w
        nh = bbox[3] / video_h

        rel_time = i / track_fps
        abs_time = start_sec + rel_time
        kf = {
            "frame": i,
            "time": round(rel_time, 4),
            "absTime": round(abs_time, 4),
            "nx": round(cx, 5),
            "ny": round(cy, 5),
            "nw": round(nw, 5),
            "nh": round(nh, 5),
            "confidence": conf
        }
        keyframes.append(kf)

        percent = round((i / total_frames) * 100, 1)
        if i % 4 == 0 or i == total_frames - 1:
            print(json.dumps({
                "type": "progress",
                "frame": i,
                "total": total_frames,
                "percent": percent,
                "time": round(rel_time, 3),
                "nx": round(cx, 4),
                "ny": round(cy, 4)
            }), flush=True)

    cap.release()

    print(json.dumps({
        "type": "done",
        "keyframes": keyframes,
        "total": len(keyframes)
    }), flush=True)


if __name__ == "__main__":
    try:
        run_tracker()
    except Exception as e:
        import traceback
        err = traceback.format_exc()
        print(json.dumps({"type": "error", "message": str(e), "traceback": err}), flush=True)
        sys.exit(1)
