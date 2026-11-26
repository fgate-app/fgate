import {usePreferences} from '../preferences.js';
import {notify} from '../lib/toasts.js';

// Forms share one error channel; drafts and dialogs remain intact on failure.
export function useFormFeedback() {
 const {t}=usePreferences();
 function reportError(failure) {
  if(failure?.name==='AbortError')return;
  const message=typeof failure==='string'?failure:failure?.message;
  notify(t(message || 'Could not complete the action. Please try again.'),'error');
 }
 function validate(checks) {
  const failed=checks.find(([valid])=>!valid);
  if(!failed)return true;
  reportError(failed[1]);
  return false;
 }
 return {reportError,validate};
}
