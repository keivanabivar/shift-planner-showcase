// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInviteLink,memberChangeConfirmation} from './accessActions.js';
import {legalHref,legalReturnHref,supportHref} from './publicInfo.js';

test('link invito usa origine e percorso correnti e contiene soltanto il token di invito',()=>{
 const location={origin:'https://turni.example',pathname:'/app/',href:'https://turni.example/app/?keep=1#section'};
 assert.equal(buildInviteLink('token sicuro',location),'https://turni.example/app/?invite=token+sicuro');
});

test('conferme sensibili identificano il membro e mostrano vecchio e nuovo valore',()=>{
 const member={user_id:'user-2',full_name:'Éxample Fixturé',role:'viewer',is_active:true};
 assert.equal(memberChangeConfirmation(member,{role:'editor'}),'Confermi il cambio di ruolo per Éxample Fixturé?\nViewer → Editor');
 assert.equal(memberChangeConfirmation(member,{isActive:false}),'Confermi il cambio di accesso per Éxample Fixturé?\nAttivo → Disattivato');
 assert.equal(memberChangeConfirmation(member,{employeeId:'employee-2'}),'');
});

test('link legali conservano il contesto e il ritorno rimuove soltanto la pagina informativa',()=>{
 const location={href:'https://turni.example/app/?invite=abc#section'};
 assert.equal(legalHref('privacy',location),'/app/?invite=abc&legal=privacy');
 assert.equal(legalReturnHref({href:'https://turni.example/app/?invite=abc&legal=privacy'}),'/app/?invite=abc');
 assert.equal(supportHref('support@example.test'),'mailto:support%40example.test');
 assert.equal(supportHref(''),'');
});
