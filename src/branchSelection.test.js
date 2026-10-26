// Synthetic showcase fixtures only; never derived from real accounts or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {branchSelectionKey,persistBranchSelection,restoreBranchSelection} from './branchSelection.js';

const memory=()=>{const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),map}};

test('la Sede selezionata persiste per utente e organizzazione',()=>{
 const storage=memory();
 persistBranchSelection(storage,'org-a','user-a',['b'],['a','b']);
 assert.deepEqual(restoreBranchSelection(storage,'org-a','user-a',['a','b']),['b']);
 assert.deepEqual(restoreBranchSelection(storage,'org-a','user-b',['a','b']),['a','b']);
 assert.equal(storage.map.has(branchSelectionKey('org-a','user-a')),true);
});

test('una Sede rimossa o non più autorizzata usa il fallback sicuro',()=>{
 const storage=memory();storage.setItem(branchSelectionKey('org','user'),JSON.stringify('b'));
 assert.deepEqual(restoreBranchSelection(storage,'org','user',['a']),['a']);
 persistBranchSelection(storage,'org','user',['a','b'],['a','b']);
 assert.deepEqual(restoreBranchSelection(storage,'org','user',['a','b']),['a','b']);
});
