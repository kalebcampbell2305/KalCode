import { Composition } from "remotion";
import { Film } from "./Film";

export const Root = () => (
  <>
    <Composition id="KalCodeLaunch" component={Film} durationInFrames={3600} fps={60} width={1920} height={1080} />
    <Composition
      id="KalCodeLaunchVertical"
      component={Film}
      durationInFrames={3600}
      fps={60}
      width={1080}
      height={1920}
    />
    <Composition id="Prototype" component={Film} durationInFrames={900} fps={60} width={1920} height={1080} />
  </>
);
