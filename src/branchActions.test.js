// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {branchActionVisibility,branchDeletionInfo} from './branchActions.js';

test('una Sede vuota disattivata resta riattivabile ed eliminabile senza azioni di recupero',()=>{
 const actions=branchActionVisibility({active:false,can_delete:true,control_state:'setup'});
 assert.deepEqual(actions,{rename:true,deactivate:false,reactivate:true,delete:true,recovery:false});
});

test('una Sede vuota mantiene l’azione di eliminazione',()=>{
 const info=branchDeletionInfo({can_delete:true,blocker_counts:{},history_counts:{}});
 assert.equal(info.available,true);
 assert.deepEqual(info.blockers,[]);
 assert.deepEqual(info.history,[]);
});

test('i dettagli separano blocchi attivi e storico',()=>{
 const info=branchDeletionInfo({can_delete:false,delete_reasons:['active_blockers'],blocker_counts:{requests:1,memberships:1,user_assignments:1,employee_assignments:1},history_counts:{requests:4,cross_branch_requests:2,audit_events:7}});
 assert.equal(info.status,'Eliminazione non disponibile · blocchi attivi');
 assert.deepEqual(info.blockers.map(item=>[item.label,item.count]),[['Richieste',1],['Amministratori e redattori',1],['Accessi operativi utenti',1],['Assegnazioni dipendenti',1]]);
 assert.deepEqual(info.history.map(item=>[item.label,item.count]),[['Richieste concluse',4],['Richieste tra sedi concluse',2],['Eventi audit',7]]);
});

test('lo storico da solo non nasconde la disponibilità di eliminazione',()=>{
 const info=branchDeletionInfo({can_delete:true,blocker_counts:{},history_counts:{requests:4,audit_events:3}});
 assert.equal(info.status,'Eliminazione disponibile');
 assert.equal(info.hasDetails,true);
 assert.deepEqual(info.blockers,[]);
 assert.equal(info.history.length,2);
});

test('non esistono motivi speciali per la prima o ultima Sede',()=>{
 const info=branchDeletionInfo({can_delete:true,is_primary:true,is_last_active:true,delete_reasons:['primary_branch','last_active_branch'],blocker_counts:{},history_counts:{}});
 assert.equal(info.status,'Eliminazione disponibile');
 assert.deepEqual(info.reasons,[]);
});

test('una Sede con dati disattivata offre riattivazione e rinomina, non recupero o eliminazione',()=>{
 const actions=branchActionVisibility({active:false,can_delete:false,control_state:'recovery'});
 assert.deepEqual(actions,{rename:true,deactivate:false,reactivate:true,delete:false,recovery:false});
});
