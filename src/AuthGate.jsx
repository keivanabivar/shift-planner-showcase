import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {createClient} from '@supabase/supabase-js';
import {createRepository} from './persistence';
import {createPlannerStore} from './plannerStore';
import {withClientProtocol,gateClientRpc,UPDATE_MESSAGE} from './clientCompatibility';
import {PublicInfoLinks,PublicInfoPage,SupportContact} from './LegalPages';

const url=import.meta.env.VITE_SUPABASE_URL||'';
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY||'';
let client=null,configurationError='';
try{
 if(!url||!key)throw Error('Configura VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY per accedere. I dati locali sono conservati.');
 createRepository(url,key); // Validate public credentials before creating the Auth client.
 client=gateClientRpc(createClient(url,key,{global:{fetch:withClientProtocol()},auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}));
}catch(error){configurationError=(!url||!key)?error.message:'Configurazione Supabase non valida. Verifica URL e chiave pubblica in .env.local. I dati locali sono conservati.';}
const redirectUrl=(recovery=false)=>{
 const target=new URL(window.location.pathname,window.location.origin);
 const invite=new URLSearchParams(window.location.search).get('invite');
 if(invite!==null)target.searchParams.set('invite',invite);
 if(recovery)target.searchParams.set('recovery','1');
 return target.href;
};
function removeQueryParam(name){const target=new URL(window.location.href);target.searchParams.delete(name);window.history.replaceState(window.history.state,'',`${target.pathname}${target.search}${target.hash}`);}
function italianError(error){
 if(['CLIENT_UPDATE_REQUIRED','P0030'].includes(error?.code))return UPDATE_MESSAGE;
 if(['invalid_credentials','email_not_confirmed'].includes(error?.code))return error.code==='email_not_confirmed'?'Conferma la tua email prima di accedere.':'Email o password non corretti.';
 if(error?.code==='weak_password')return 'Scegli una password più sicura, di almeno 8 caratteri.';
 if(error?.code==='over_email_send_rate_limit'||error?.status===429)return 'Troppi tentativi. Attendi qualche minuto e riprova.';
 if(['user_already_exists','email_exists','email_address_not_authorized'].includes(error?.code))return 'Esiste già un account con questa email. Torna ad Accedi e usa l’account invitato.';
 if(error?.code==='PGRST202')return 'Configurazione del database incompleta. È necessaria la migrazione delle organizzazioni.';
 return 'Operazione non riuscita. Verifica la connessione e riprova.';
}
function Shell({children}){return <main className="auth-screen"><section className="content-panel auth-card"><div className="brand">SHIFT PLANNER</div>{children}<PublicInfoLinks/></section></main>;}
export function PasswordField({label,value,onChange,...props}){
 const [visible,setVisible]=useState(false),id=useId();
 useEffect(()=>setVisible(false),[label,props.autoComplete]);
 return <div className="password-control"><label htmlFor={id}>{label}</label><span className="password-field"><input {...props} id={id} type={visible?'text':'password'} value={value} onChange={onChange}/><button type="button" className="password-toggle" aria-label={visible?'Nascondi password':'Mostra password'} aria-pressed={visible} onClick={()=>setVisible(current=>!current)}><span aria-hidden="true">{visible?'◉':'◌'}</span></button></span></div>;
}

function AuthForm({recovery,onRecovered}){
 const invite=new URLSearchParams(window.location.search).get('invite');
 const [mode,setMode]=useState('login'),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[repeat,setRepeat]=useState('');
 const [organization,setOrganization]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [inviteEmail,setInviteEmail]=useState(null),[inviteLoading,setInviteLoading]=useState(false),[inviteError,setInviteError]=useState('');
 const current=recovery?'recovery':mode;
 useEffect(()=>{
  if(current!=='register'||invite===null){setInviteEmail(null);setInviteError('');setInviteLoading(false);return;}
  let cancelled=false;setInviteLoading(true);setInviteError('');setInviteEmail(null);
  client.rpc('organization_invite_resolve',{p_token:invite}).then(({data,error})=>{
   if(cancelled)return;
   if(error)setInviteError(italianError(error));
   else if(!data?.email)setInviteError('Invito non valido o scaduto. Chiedi un nuovo invito all’amministratore.');
   else setInviteEmail(data.email);
  }).catch(()=>{if(!cancelled)setInviteError('Connessione non disponibile. Riprova.');}).finally(()=>{if(!cancelled)setInviteLoading(false);});
  return()=>{cancelled=true};
 },[current,invite]);
 async function submit(event){event.preventDefault();setError('');setMessage('');setBusy(true);
 try{
 let result;
 if(current==='register'){
 if(password!==repeat){setError('Le password non coincidono.');return;}
 if(invite!==null){
 if(!inviteEmail){setError(inviteError||'Attendi la verifica dell’invito.');return;}
 const check=await client.rpc('organization_invite_check',{p_token:invite,p_email:inviteEmail});
 if(check.error){setError(italianError(check.error));return;}
 if(check.data!==true){setInviteEmail(null);setInviteError('Invito non valido o scaduto. Chiedi un nuovo invito all’amministratore.');return;}
 }
 result=await client.auth.signUp({email:invite!==null?inviteEmail:email.trim(),password,options:{emailRedirectTo:redirectUrl(),data:invite!==null?{}:{organization_name:organization.trim(),full_name:name.trim()}}});
 if(!result.error){setPassword('');setRepeat('');setMessage(new URLSearchParams(window.location.search).has('invite')?'Controlla la tua email e conferma l’account. Poi accedi per accettare l’invito.':'Controlla la tua email e conferma l’account. Poi accedi per completare la creazione della tua organizzazione.');}
 }else if(current==='reset'){
 result=await client.auth.resetPasswordForEmail(email.trim(),{redirectTo:redirectUrl(true)});
 if(!result.error)setMessage('Se l’indirizzo è registrato, riceverai un’email con il collegamento per reimpostare la password.');
 }else if(current==='recovery'){
 if(password!==repeat){setError('Le password non coincidono.');return;}
 result=await client.auth.updateUser({password});
 if(!result.error){removeQueryParam('recovery');onRecovered();}
 }else result=await client.auth.signInWithPassword({email:email.trim(),password});
 if(result.error)setError(italianError(result.error));
 }catch{setError('Connessione non disponibile. Riprova.');}finally{setBusy(false);}}
 const title={login:'Accedi',register:'Crea account',reset:'Password dimenticata?',recovery:'Nuova password'}[current];
 return <Shell><h1>{title}</h1><form onSubmit={submit}>
 {current==='register'&&invite===null&&<><label>Nome organizzazione<input required maxLength={200} value={organization} onChange={e=>setOrganization(e.target.value)} autoComplete="organization"/></label><label>Nome responsabile<input required maxLength={200} value={name} onChange={e=>setName(e.target.value)} autoComplete="name"/></label></>}
 {current!=='recovery'&&(current==='register'&&invite!==null?<label>Email invitata<input type="email" required readOnly aria-readonly="true" value={inviteEmail||''} autoComplete="email"/></label>:<label>Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email"/></label>)}
 {current!=='reset'&&<PasswordField label={current==='recovery'?'Nuova password':'Password'} required minLength={current==='login'?1:8} value={password} onChange={e=>setPassword(e.target.value)} autoComplete={current==='login'?'current-password':'new-password'}/>}
 {(current==='recovery'||current==='register')&&<PasswordField label="Conferma password" required minLength={8} value={repeat} onChange={e=>setRepeat(e.target.value)} autoComplete="new-password"/>}
 {inviteLoading&&<p role="status">Verifica invito…</p>}{inviteError&&<p role="alert" className="error">{inviteError}</p>}{error&&<p role="alert" className="error">{error}</p>}{message&&<p role="status">{message}</p>}
 <button className="primary" disabled={busy||inviteLoading||(current==='register'&&invite!==null&&!inviteEmail)}>{busy?'Attendi…':{login:'Entra',register:'Crea account',reset:'Invia collegamento',recovery:'Salva password'}[current]}</button></form>
 {!recovery&&<div className="auth-links">{current==='login'?<><button onClick={()=>{setMode('reset');setError('');setMessage('')}}>Password dimenticata?</button><button onClick={()=>{setMode('register');setError('');setMessage('')}}>Crea account</button></>:<button onClick={()=>{setMode('login');setError('');setMessage('')}}>Torna ad Accedi</button>}</div>}</Shell>;
}
function InviteAcceptance({session,token,onReady,onSignOut}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(event){
  event.preventDefault();if(busy)return;setError('');
  setBusy(true);
  try{
   const {data,error}=await client.rpc('organization_invite_accept',{p_token:token});
   if(error)throw error;
   if(!data?.organization_id||data.user_id!==session.user.id)throw Error('Invalid account context');
   onReady(data);
  }catch(error){
   setError(error?.message==='Confirmed email required'?'Conferma la tua email prima di accettare l’invito.':error?.message?.startsWith('Account already has a membership')?'Questo account appartiene già a un’organizzazione. Accedi con l’account invitato o contatta un amministratore.':error?.code==='42501'?'Invito non valido, scaduto o non disponibile per questo account. Accedi con l’email invitata o chiedi un nuovo invito.':italianError(error));
  }finally{setBusy(false);}
 }
 return <Shell><h1>Accetta invito</h1><p>Accedi all’organizzazione con {session.user.email}.</p><form onSubmit={submit}>{error&&<p role="alert" className="error">{error}</p>}<button className="primary" disabled={busy}>{busy?'Accettazione…':'Accetta invito'}</button></form><button disabled={busy} onClick={onSignOut}>Esci</button></Shell>;
}
function Onboarding({session,onReady,onSignOut}){
 const [organization,setOrganization]=useState(session.user.user_metadata?.organization_name||'');
 const [branch,setBranch]=useState('');
 const [name,setName]=useState(session.user.user_metadata?.full_name||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(e){e.preventDefault();setBusy(true);setError('');try{const {data,error}=await client.rpc('organization_onboard',{organization_name:organization.trim(),manager_name:name.trim(),first_branch_name:branch.trim()});if(error)throw error;onReady(data);}catch(error){setError(italianError(error));}finally{setBusy(false);}}
 return <Shell><h1>La tua organizzazione</h1><p>Indica il gruppo e la prima sede operativa.</p><form onSubmit={submit}><label>Nome organizzazione<input required maxLength={200} value={organization} onChange={e=>setOrganization(e.target.value)}/></label><label>Nome prima Sede<input required maxLength={200} value={branch} onChange={e=>setBranch(e.target.value)}/></label><label>Nome responsabile<input required maxLength={200} value={name} onChange={e=>setName(e.target.value)}/></label>{error&&<p role="alert" className="error">{error}</p>}<button className="primary" disabled={busy}>{busy?'Creazione…':'Crea organizzazione'}</button></form><button disabled={busy} onClick={onSignOut}>Esci</button></Shell>;
}
export function AccountMenu({account,onUpdated,onSignOut}){
 return <div className="account-menu" aria-label="Utente connesso"><strong>{account.full_name||'Account'}</strong></div>;
}

export function AccountSettingsView({account,onUpdated,allowOrganization=false}){
 const [name,setName]=useState(account.full_name||''),[organization,setOrganization]=useState(account.organization_name||''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 async function save(event){event.preventDefault();setBusy(true);setError('');setMessage('');try{const args={manager_name:name.trim(),...(allowOrganization?{organization_name:organization.trim()}:{})};const {data,error}=await client.rpc('account_update',args);if(error)throw error;onUpdated(data);setMessage('Impostazioni account salvate.');}catch(error){setError(italianError(error));}finally{setBusy(false);}}
 async function reset(){setBusy(true);setError('');setMessage('');try{const {error}=await client.auth.resetPasswordForEmail(account.email,{redirectTo:redirectUrl(true)});if(error)throw error;setMessage('Controlla la tua email per modificare la password.');}catch(error){setError(italianError(error));}finally{setBusy(false);}}
 return <section className="content-panel account-settings"><div className="panel-heading"><div><p className="eyebrow">IMPOSTAZIONI ACCOUNT</p><h2>{allowOrganization?'Account e organizzazione':'Il tuo account'}</h2><p>{allowOrganization?'Aggiorna il nome visualizzato e il nome dell’organizzazione.':'Gestisci soltanto le informazioni personali e l’accesso.'}</p></div></div><form onSubmit={save}><label>Email<input value={account.email||''} readOnly/></label><label>Nome utente<input required maxLength={200} value={name} onChange={event=>setName(event.target.value)}/></label>{allowOrganization&&<label>Nome organizzazione<input required maxLength={200} value={organization} onChange={event=>setOrganization(event.target.value)}/></label>}<div className="settings-actions"><button type="button" disabled={busy||!account.email} onClick={reset}>Modifica password</button><button className="primary" disabled={busy||!name.trim()||(allowOrganization&&!organization.trim())}>{busy?'Salvataggio…':'Salva'}</button></div>{error&&<p className="error" role="alert">{error}</p>}{message&&<p className="save-confirmation" role="status">{message}</p>}</form><div className="account-support"><h3>Privacy e assistenza</h3><PublicInfoLinks/><p>Per richiedere la cancellazione dell’account e dei dati, contatta il supporto: <SupportContact/></p></div></section>;
}
function Workspace({account,onUpdated,onSignOut,children}){
 const repository=useMemo(()=>createRepository(url,key,fetch,{
  userId:account.user_id,
  organizationId:account.organization_id,
  getSession:async()=>{
   const {data,error}=await client.auth.getSession();
   if(error)throw error;
   return data.session;
  }
 }),[account.user_id,account.organization_id]);

 const store=useMemo(()=>createPlannerStore({
  storage:localStorage,
  repository,
  project:url,
  organizationId:account.organization_id,
  userId:account.user_id
 }),[repository,account.user_id,account.organization_id]);

 useEffect(()=>()=>store.dispose(),[store]);

 return children({store,repository,account,onUpdated,onSignOut});
}

export default function AuthGate({children}){
 const legalPage=new URLSearchParams(window.location.search).get('legal');
 const [session,setSession]=useState(undefined),[account,setAccount]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const [recovery,setRecovery]=useState(new URLSearchParams(window.location.search).get('recovery')==='1');
 const [invite,setInvite]=useState(()=>new URLSearchParams(window.location.search).get('invite'));
 const [retry,setRetry]=useState(0);const activeUser=useRef(null);
 useEffect(()=>{if(!client)return;const {data:{subscription}}=client.auth.onAuthStateChange((event,next)=>{
 if(activeUser.current!==next?.user?.id){setAccount(null);setLoading(true);activeUser.current=next?.user?.id||null;}
 if(event==='PASSWORD_RECOVERY')setRecovery(true);
 if(event==='SIGNED_OUT')setRecovery(false);
 setSession(next);
 });return()=>subscription.unsubscribe();},[]);
 useEffect(()=>{if(!session?.user?.id)return;let cancelled=false;setLoading(true);setError('');
 client.rpc('account_context').then(({data,error})=>{if(cancelled)return;if(error){setError(italianError(error));setAccount(null);}else if(data&&data.user_id!==session.user.id){setError('Sessione non valida. Accedi di nuovo.');setAccount(null);}else setAccount(data?{...data,email:session.user.email||''}:data);setLoading(false);}).catch(()=>{if(!cancelled){setError('Connessione non disponibile. Riprova.');setLoading(false);}});
 return()=>{cancelled=true};},[session?.user?.id,retry]);
 async function signOut(){setAccount(null);setSession(null);activeUser.current=null;const {error}=await client.auth.signOut({scope:'local'});if(error)setError('Uscita non completata. Riprova quando la connessione è disponibile.');}
 function updateAccount(data){if(data?.user_id===activeUser.current)setAccount(current=>({...data,email:current?.email||session?.user?.email||''}));}
 if(['privacy','terms','support'].includes(legalPage))return <PublicInfoPage page={legalPage}/>;
 if(configurationError)return <Shell><h1>Configurazione richiesta</h1><p role="alert">{configurationError}</p></Shell>;
 if(session===undefined)return <Shell><p role="status">Verifica accesso…</p></Shell>;
 if(!session&&recovery)return <Shell><h1>Collegamento non valido</h1><p role="alert">Il collegamento di recupero è scaduto o non valido. Richiedi una nuova email.</p><button onClick={()=>{removeQueryParam('recovery');window.history.replaceState(null,'',window.location.pathname+window.location.search);setRecovery(false);}}>Torna ad Accedi</button></Shell>;
 if(!session)return <AuthForm/>;
 if(recovery)return <AuthForm recovery onRecovered={()=>setRecovery(false)}/>;
 if(loading)return <Shell><p role="status">Caricamento organizzazione…</p><button onClick={signOut}>Esci</button></Shell>;
 if(error)return <Shell><p role="alert">{error}</p><button onClick={()=>setRetry(v=>v+1)}>Riprova</button><button onClick={signOut}>Esci</button></Shell>;
 if(invite!==null)return <InviteAcceptance key={`${session.user.id}:${invite}`} session={session} token={invite} onReady={data=>{if(data.user_id!==activeUser.current)return;updateAccount(data);removeQueryParam('invite');setInvite(null);}} onSignOut={signOut}/>;
 if(!account)return <Onboarding key={session.user.id} session={session} onReady={updateAccount} onSignOut={signOut}/>;
 if(account.user_id!==session.user.id)return <Shell><p>Verifica accesso…</p></Shell>;
 return <Workspace key={`${account.user_id}:${account.organization_id}`} account={account} onUpdated={updateAccount} onSignOut={signOut}>{children}</Workspace>;
}
