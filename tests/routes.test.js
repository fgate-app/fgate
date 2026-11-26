import test from 'node:test';
import assert from 'node:assert/strict';
import {stateFor,locationFor,routePaths,settingsPaths,pagePaths} from '../web/src/lib/routes.js';
test('URL/state roundtrip for pages, route types and settings',()=>{
 for(const [page,path] of Object.entries(pagePaths))assert.equal(stateFor(path).page,page);
 for(const section of Object.keys(routePaths)){const path=locationFor('Маршруты',section);assert.deepEqual(stateFor(path),{page:'Маршруты',routeSection:section});}
 for(const section of Object.keys(settingsPaths)){const path=locationFor('Настройки',null,section);assert.deepEqual(stateFor(path),{page:'Настройки',settingsSection:section});}
 assert.equal(stateFor('/unknown').page,'Обзор');assert.equal(stateFor('/').page,'Обзор');assert.equal(stateFor('/system/').page,'Обзор');
});

test('access points have a standalone URL and old clients links remain usable',()=>{
 assert.equal(locationFor('Точки доступа'),'/access-points');
 for(const path of ['/incoming','/clients/access-points','/access-points'])assert.deepEqual(stateFor(path),{page:'Точки доступа'});
 assert.equal(locationFor('Клиенты',null,null,null,'Точки доступа'),'/clients');
});

test('subscriptions have a stable connection section URL',()=>{assert.equal(locationFor('Подключения',null,null,'Подписки'),'/connections/subscriptions');assert.deepEqual(stateFor('/connections/subscriptions/'),{page:'Подключения',connectionSection:'Подписки'});});
