import '../web/src/style.css';
import { usePreferences } from '../web/src/preferences.js';
export const globalTypes = {
  theme:{description:'Theme',toolbar:{icon:'paintbrush',items:[{value:'dark',title:'Dark'},{value:'light',title:'Light'}]}},
  locale:{description:'Language',toolbar:{icon:'globe',items:[{value:'en',title:'English'},{value:'ru',title:'Русский'},{value:'zh-CN',title:'简体中文'}]}},
};
export const initialGlobals = { theme:'dark',locale:'en' };
export const parameters = { layout:'padded', controls:{expanded:true}, a11y:{test:'todo'} };
export const decorators = [(story,context)=>{
  const {theme,locale}=usePreferences();theme.value=context.globals.theme||'dark';locale.value=context.globals.locale||'en';
  return {components:{story},template:'<div class="storybook-stage"><story /></div>'};
}];

import '../web/src/mobile.css';
