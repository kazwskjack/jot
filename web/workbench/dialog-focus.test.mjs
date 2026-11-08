import test from 'node:test';
import assert from 'node:assert/strict';
import {dialogTabBoundaryTarget} from './dialog-focus.mjs';

test('Tab wraps from the last dialog control to the first and Shift+Tab wraps back',()=>{
 const first={},middle={},last={};
 const focusable=[first,middle,last];
 assert.equal(dialogTabBoundaryTarget(last,focusable,false),first);
 assert.equal(dialogTabBoundaryTarget(first,focusable,true),last);
 assert.equal(dialogTabBoundaryTarget(middle,focusable,false),null);
 assert.equal(dialogTabBoundaryTarget(middle,focusable,true),null);
});
