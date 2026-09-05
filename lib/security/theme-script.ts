/**
 * The pre-paint theme script.
 *
 * It lives in its own module so `app/layout.tsx` renders exactly the string
 * the Content-Security-Policy in `next.config.ts` was written against. See
 * that file for why script-src cannot pin this by hash today.
 */
export const THEME_SCRIPT = `try{if(localStorage.getItem("myreply-theme")==="dark"){document.documentElement.classList.add("dark")}}catch(e){}`;
