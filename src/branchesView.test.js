// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshBranches} from './branchRefresh.js';

test('una modifica alle Sedi aggiorna prima la vista locale e poi lo stato globale',async()=>{
 const calls=[];
 await refreshBranches(async()=>calls.push('local'),async()=>calls.push('global'));
 assert.deepEqual(calls,['local','global']);
});

test('l’aggiornamento globale resta opzionale',async()=>{
 let loaded=false;
 await refreshBranches(async()=>{loaded=true});
 assert.equal(loaded,true);
});
