import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { LessonVideo, type LessonVideoProps } from './LessonVideo';
import 'katex/dist/katex.min.css';

const empty: LessonVideoProps = { plan: { schemaVersion: '0.1', revision: 1, title: '', fps: 30, width: 1280, height: 720, theme: 'sage', totalFrames: 1, scenes: [] }, assets: [] };
function Root() {
  return <Composition id="OpenTutorLesson" component={LessonVideo} width={1280} height={720} fps={30} durationInFrames={1} defaultProps={empty} calculateMetadata={({ props }) => ({ durationInFrames: props.plan.totalFrames, width: props.plan.width, height: props.plan.height, fps: props.plan.fps })} />;
}
registerRoot(Root);
