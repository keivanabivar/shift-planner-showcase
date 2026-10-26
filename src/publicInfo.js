export const SUPPORT_EMAIL=(import.meta.env?.VITE_SUPPORT_EMAIL||'').trim()||'support@example.invalid';

export function legalHref(page,location=window.location){
 const target=new URL(location.href);
 target.searchParams.set('legal',page);
 target.hash='';
 return `${target.pathname}${target.search}`;
}

export function legalReturnHref(location=window.location){
 const target=new URL(location.href);
 target.searchParams.delete('legal');
 target.hash='';
 return `${target.pathname}${target.search}`;
}

export function supportHref(email=SUPPORT_EMAIL){
 return email?`mailto:${encodeURIComponent(email)}`:'';
}
