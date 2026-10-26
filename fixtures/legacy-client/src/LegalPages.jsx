import React from 'react';
import {legalHref,legalReturnHref,SUPPORT_EMAIL,supportHref} from './publicInfo';

export function PublicInfoLinks({className='public-info-links'}){
 return <nav className={className} aria-label="Informazioni legali e assistenza">
  <a href={legalHref('privacy')}>Informativa privacy del pilot</a>
  <a href={legalHref('terms')}>Condizioni del pilot</a>
  <a href={legalHref('support')}>Supporto e privacy</a>
 </nav>;
}
export function SupportContact(){return <a href={supportHref()}>Scrivi a {SUPPORT_EMAIL}</a>;}
const pages={
 privacy:{title:'Informativa privacy del pilot',body:<>
  <p>Questa versione dimostrativa usa soltanto dati fittizi. Non inserire dati personali o informazioni di lavoro reali.</p>
  <h2>Configurazione indipendente</h2><p>Chi distribuisce una propria istanza deve definire finalità, ruoli, conservazione e fornitori e preparare le proprie informazioni sulla privacy prima di un utilizzo reale.</p>
  <h2>Account e dati</h2><p>L’autenticazione e i dati appartengono al progetto di sviluppo configurato dall’operatore. Questo codice non contiene account, esportazioni utenti o credenziali di produzione.</p>
 </>},
 terms:{title:'Condizioni del pilot / Beta Notice',body:<>
  <p>Questo è un progetto dimostrativo in sviluppo. Le pagine informative sono esempi e non costituiscono condizioni definitive per un servizio operativo.</p>
  <h2>Uso dimostrativo</h2><p>Usa un ambiente di sviluppo isolato e dati sintetici. Verifica sicurezza, backup e funzionamento prima di un utilizzo reale.</p>
 </>},
 support:{title:'Supporto e privacy',body:<>
  <p>Il contatto seguente è un segnaposto dimostrativo, non un canale di assistenza attivo.</p>
  <p><SupportContact/></p>
  <h2>Configurazione</h2><p>Il responsabile di un’istanza indipendente deve configurare il proprio contatto e il processo per le richieste relative ad account e dati.</p>
 </>}
};
export function PublicInfoPage({page}){
 const content=pages[page]||pages.support;
 return <main className="auth-screen"><article className="content-panel public-info-page">
  <div className="brand">SHIFT PLANNER</div><p className="draft-label">DEMO · DATI FITTIZI</p><h1>{content.title}</h1>{content.body}
  <PublicInfoLinks/><a className="button-link" href={legalReturnHref()}>Torna all’app</a>
 </article></main>;
}
