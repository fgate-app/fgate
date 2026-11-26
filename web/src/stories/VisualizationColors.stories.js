import VisualizationColorsPreview from './VisualizationColorsPreview.vue';
export default {
 title:'Foundations/Visualization colors',component:VisualizationColorsPreview,
 parameters:{layout:'padded',docs:{description:{component:'Six visualization color families. Base/strong strokes and markers; opaque soft/subtle fills. Theme-specific HEX values and measured base-to-card contrast. Teal and violet retain HTTP/UDP semantics. Examples use synthetic data; multiple-series charts also use line styles and markers.'}}},
 argTypes:{compare:{control:'boolean'},mode:{control:'select',options:['all','palette','examples','ping']}}
};
export const Palette={args:{mode:'palette'}};
export const LightTheme={args:{mode:'all'},globals:{theme:'light'}};
export const DarkTheme={args:{mode:'all'},globals:{theme:'dark'}};
export const CompareThemes={args:{mode:'palette',compare:true}};
export const ChartExamples={args:{mode:'examples'}};
export const Ping={args:{mode:'ping'}};
