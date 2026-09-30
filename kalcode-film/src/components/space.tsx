// A small 3D stage built on CSS 3D transforms: a camera and planes placed in world space.
// Text stays vector-crisp at any depth (unlike a WebGL texture), and every value is a pure
// function of the frame.
import type React from "react";
import { C, FONT } from "../brand/tokens";
import { useStage } from "./core";

export type Pose = {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  s?: number;
  o?: number;
};
export type Cam = { x: number; y: number; z: number; rx?: number; ry?: number; rz?: number; fov?: number };

const L = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpPose = (a: Pose, b: Pose, t: number): Pose => ({
  x: L(a.x ?? 0, b.x ?? 0, t),
  y: L(a.y ?? 0, b.y ?? 0, t),
  z: L(a.z ?? 0, b.z ?? 0, t),
  rx: L(a.rx ?? 0, b.rx ?? 0, t),
  ry: L(a.ry ?? 0, b.ry ?? 0, t),
  rz: L(a.rz ?? 0, b.rz ?? 0, t),
  s: L(a.s ?? 1, b.s ?? 1, t),
  o: L(a.o ?? 1, b.o ?? 1, t),
});

/** World container with an orbit camera: (x, y) is the look-at target, z the distance (0 = scale 1). */
export const Space: React.FC<{ cam: Cam; children: React.ReactNode; style?: React.CSSProperties }> = ({
  cam,
  children,
  style,
}) => {
  const { W, H } = useStage();
  const persp = cam.fov ?? 1600;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        perspective: persp,
        perspectiveOrigin: "50% 50%",
        overflow: "hidden",
        fontFamily: FONT.ui,
        color: C.text,
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: W / 2,
          top: H / 2,
          width: 0,
          height: 0,
          transformStyle: "preserve-3d",
          // orbit camera: the target (x, y, z) stays centred; z-distance pulls back, angles orbit around it
          transform: `translateZ(${-cam.z}px) rotateZ(${-(cam.rz ?? 0)}deg) rotateX(${cam.rx ?? 0}deg) rotateY(${-(cam.ry ?? 0)}deg) translate3d(${-cam.x}px, ${-cam.y}px, 0px)`,
        }}
      >
        {children}
      </div>
    </div>
  );
};

/** A plane of size w×h whose CENTRE sits at the pose. */
export const Plane: React.FC<{
  pose: Pose;
  w: number;
  h: number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  blur?: number;
}> = ({ pose, w, h, children, style, blur = 0 }) => (
  <div
    style={{
      position: "absolute",
      left: -w / 2,
      top: -h / 2,
      width: w,
      height: h,
      transformStyle: "preserve-3d",
      transform: `translate3d(${pose.x ?? 0}px, ${pose.y ?? 0}px, ${pose.z ?? 0}px) rotateY(${pose.ry ?? 0}deg) rotateX(${pose.rx ?? 0}deg) rotateZ(${pose.rz ?? 0}deg) scale(${pose.s ?? 1})`,
      opacity: pose.o ?? 1,
      filter: blur > 0.05 ? `blur(${blur}px)` : undefined,
      backfaceVisibility: "hidden",
      ...style,
    }}
  >
    {children}
  </div>
);
