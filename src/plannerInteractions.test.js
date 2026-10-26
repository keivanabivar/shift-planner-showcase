// Synthetic showcase fixtures only; never derived from real accounts or exports.
import {makeLegacyShift as makeShift} from './testFixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBulkAssignment,applyBulkDeletion,assignmentConflicts,bulkDeletionTargets,selectedRangeDates} from './bulkEditing.js';
import {DEFAULT_EMPLOYEE_COLUMN_WIDTH,MAX_EMPLOYEE_COLUMN_WIDTH,MIN_EMPLOYEE_COLUMN_WIDTH,clampEmployeeColumnWidth,moveEmployee,moveEmployeeTo,normalizeEmployeeOrder,orderEmployees,sortEmployeesAlphabetically} from './userPreferences.js';

const employees=[{id:'a',name:'Demo Sample 016'},{id:'b',name:'DemoBeta'},{id:'c',name:'Demo Sample 023'}];
const morning=makeShift('Mattina');

test('assegnazione selezionata applica lo stesso turno a tutto l’intervallo senza mutare l’origine',()=>{
 const data={version:1,employees,shifts:{}},dates=selectedRangeDates({start:'2026-10-02',end:'2026-10-04'},'2026-10-03'),next=applyBulkAssignment(data,'a',dates,morning);
 assert.deepEqual(dates,['2026-10-02','2026-10-03','2026-10-04']);
 for(const date of dates)assert.deepEqual(next.shifts[`a|${date}`],morning);
 assert.deepEqual(data.shifts,{});
});

test('conflitti di intervallo includono solo assegnazioni realmente diverse',()=>{
 const afternoon=makeShift('Pomeriggio'),data={version:1,employees,shifts:{'a|2026-10-02':morning,'a|2026-10-03':afternoon}};
 assert.deepEqual(assignmentConflicts(data,'a',['2026-10-02','2026-10-03','2026-10-04'],morning),['2026-10-03']);
});

test('eliminazione selezionata rimuove atomicamente solo i target presenti',()=>{
 const data={version:1,employees,shifts:{'a|2026-10-02':morning,'a|2026-10-03':morning,'b|2026-10-02':morning}},dates=['2026-10-02','2026-10-03','2026-10-04'];
 assert.deepEqual(bulkDeletionTargets(data,'a',dates),['2026-10-02','2026-10-03']);
 const next=applyBulkDeletion(data,'a',dates);
 assert.deepEqual(Object.keys(next.shifts),['b|2026-10-02']);
});

test('ridimensionamento rispetta min/max e usa un valore predefinito sicuro',()=>{
 assert.equal(clampEmployeeColumnWidth(10),MIN_EMPLOYEE_COLUMN_WIDTH);
 assert.equal(clampEmployeeColumnWidth(999),MAX_EMPLOYEE_COLUMN_WIDTH);
 assert.equal(clampEmployeeColumnWidth('bad'),DEFAULT_EMPLOYEE_COLUMN_WIDTH);
});

test('ordine personale conserva i nuovi dipendenti e non cambia la lista condivisa',()=>{
 const original=structuredClone(employees),saved=['c','a'],normalized=normalizeEmployeeOrder(saved,employees);
 assert.deepEqual(normalized,['c','a','b']);
 assert.deepEqual(orderEmployees(employees,saved).map(item=>item.id),['c','a','b']);
 assert.deepEqual(moveEmployee(normalized,employees,'a',-1),['a','c','b']);
 assert.deepEqual(employees,original);
});

test('trascinamento riordina la riga completa nella sequenza personale',()=>{
 const next=moveEmployeeTo(['a','b','c'],employees,'c','a','before');
 assert.deepEqual(next,['c','a','b']);
 assert.deepEqual(orderEmployees(employees,next).map(item=>item.id),['c','a','b']);
 assert.deepEqual(moveEmployeeTo(next,employees,'c','b','after'),['a','b','c']);
});

test('Dipendenti usa un ordine alfabetico stabile indipendente dal planner',()=>{
 const source=[{id:'z',name:'zeta'},{id:'a2',name:'Álvaro'},{id:'a1',name:'alvaro'},{id:'b',name:'DemoBeta'}];
 const planner=orderEmployees(source,['z','b','a1','a2']);
 assert.deepEqual(planner.map(item=>item.id),['z','b','a1','a2']);
 assert.deepEqual(sortEmployeesAlphabetically(source).map(item=>item.id),['a2','a1','b','z']);
});
