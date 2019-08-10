// ==UserScript==
// @name         WME Straighten Up! (beta)
// @namespace   https://greasyfork.org/users/166843
// @version      2019.08.10.01
// @description  Straighten selected WME segment(s) by aligning along straight line between two end points and removing geometry nodes.
// @author       dBsooner
// @include     /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @require     https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @grant        none
// @license      GPLv3
// ==/UserScript==

// Original credit to jonny3D and impulse200

/* global localStorage, window, $, performance, I18n, GM_info, W, WazeWrap */

const ALERT_UPDATE = true,
    DEBUG = true,
    LOAD_BEGIN_TIME = performance.now(),
    // SCRIPT_AUTHOR = GM_info.script.author,
    SCRIPT_FORUM_URL = '',
    SCRIPT_GF_URL = 'https://greasyfork.org/en/scripts/388349-wme-straighten-up',
    SCRIPT_NAME = GM_info.script.name.replace('(beta)', 'β'),
    SCRIPT_VERSION = GM_info.script.version,
    SCRIPT_VERSION_CHANGES = ['<b>NEW:</b> Initial release.',
        '<b>NEW:</b> Check for micro dog legs.',
        '<b>NEW:</b> Restrict to rank 3+.',
        '<b>CHANGE:</b> New name... (sketch)',
        '<b>CHANGE:</b> Determine true end point segments and align only junction nodes between them.',
        '<b>CHANGE:</b> Selecting only one segment will only remove geometry nodes'],
    SETTINGS_STORE_NAME = 'WMESU',
    _timeouts = { bootstrap: undefined };
let _moveNode,
    _settings = {},
    _updateSegmentGeometry;

function loadSettingsFromStorage() {
    return new Promise(async resolve => {
        const defaultSettings = {
                conflictingNames: 'warning',
                nonContinuousSelection: 'warning',
                sanityCheck: 'warning',
                lastSaved: 0,
                lastVersion: undefined
            },
            loadedSettings = $.parseJSON(localStorage.getItem(SETTINGS_STORE_NAME));
        _settings = $.extend({}, defaultSettings, loadedSettings);
        const serverSettings = await WazeWrap.Remote.RetrieveSettings(SETTINGS_STORE_NAME);
        if (serverSettings && (serverSettings.lastSaved > _settings.lastSaved))
            $.extend(_settings, serverSettings);
        resolve();
    });
}

function saveSettingsToStorage() {
    if (localStorage) {
        _settings.lastVersion = SCRIPT_VERSION;
        _settings.lastSaved = Date.now();
        localStorage.setItem(SETTINGS_STORE_NAME, JSON.stringify(_settings));
        WazeWrap.Remote.SaveSettings(SETTINGS_STORE_NAME, _settings);
        logDebug('Settings saved.');
    }
}

function showScriptInfoAlert() {
    if (ALERT_UPDATE && SCRIPT_VERSION !== _settings.lastVersion) {
        let releaseNotes = '';
        releaseNotes += `<p>${I18n.t('wmesu.common.WhatsNew')}:</p>`;
        if (SCRIPT_VERSION_CHANGES.length > 0) {
            releaseNotes += '<ul>';
            for (let idx = 0; idx < SCRIPT_VERSION_CHANGES.length; idx++)
                releaseNotes += `<li>${SCRIPT_VERSION_CHANGES[idx]}`;
            releaseNotes += '</ul>';
        }
        else {
            releaseNotes += `<ul><li>${I18n.t('wmesu.common.NothingMajor')}</ul>`;
        }
        WazeWrap.Interface.ShowScriptUpdate(SCRIPT_NAME, SCRIPT_VERSION, releaseNotes, SCRIPT_GF_URL, SCRIPT_FORUM_URL);
    }
}

function checkTimeout(obj) {
    if (obj.toIndex) {
        if (_timeouts[obj.timeout] && (_timeouts[obj.timeout][obj.toIndex] !== undefined)) {
            window.clearTimeout(_timeouts[obj.timeout][obj.toIndex]);
            _timeouts[obj.timeout][obj.toIndex] = undefined;
        }
    }
    else {
        if (_timeouts[obj.timeout] !== undefined)
            window.clearTimeout(_timeouts[obj.timeout]);
        _timeouts[obj.timeout] = undefined;
    }
}

function log(message) { console.log('WME-SU:', message); }
function logError(message) { console.error('WME-SU:', message); }
function logWarning(message) { console.warn('WME-SU:', message); }
function logDebug(message) {
    if (DEBUG)
        console.log('WME-SU:', message);
}

// рассчитаем пересчечение перпендикуляра точки с наклонной прямой
// Calculate the intersection of the perpendicular point with an inclined line
function getIntersectCoord(a, b, c, d) {
    // второй вариант по-проще: http://rsdn.ru/forum/alg/2589531.hot
    const r = [2];
    r[1] = -1.0 * (c * b - a * d) / (a * a + b * b);
    r[0] = (-r[1] * (b + a) - c + d) / (a - b);
    return { x: r[0], y: r[1] };
}

// определим направляющие
// Define guides
function getDeltaDirect(a, b) {
    let d = 0.0;
    if (a < b)
        d = 1.0;
    else if (a > b)
        d = -1.0;
    return d;
}

function checkNameContinuity(selectedFeatures) {
    const streetIds = [];
    for (let idx = 0; idx < selectedFeatures.length; idx++) {
        if (idx > 0) {
            if ((selectedFeatures[idx].model.attributes.primaryStreetID > 0) && (streetIds.indexOf(selectedFeatures[idx].model.attributes.primaryStreetID) > -1))
                // eslint-disable-next-line no-continue
                continue;
            if (selectedFeatures[idx].model.attributes.streetIDs.length > 0) {
                let included = false;
                for (let idx2 = 0; idx2 < selectedFeatures[idx].model.attributes.streetIDs.length; idx2++) {
                    if (streetIds.indexOf(selectedFeatures[idx].model.attributes.streetIDs[idx2]) > -1) {
                        included = true;
                        break;
                    }
                }
                if (included === true)
                    // eslint-disable-next-line no-continue
                    continue;
                else
                    return false;
            }
            return false;
        }
        if (idx === 0) {
            if (selectedFeatures[idx].model.attributes.primaryStreetID > 0)
                streetIds.push(selectedFeatures[idx].model.attributes.primaryStreetID);
            if (selectedFeatures[idx].model.attributes.streetIDs.length > 0)
                selectedFeatures[idx].model.attributes.streetIDs.forEach(streetId => { streetIds.push(streetId); });
        }
    }
    return true;
}

function distanceBetweenPointsInKM(lon1, lat1, lon2, lat2) {
    lon1 *= 0.017453292519943295; // 0.017453292519943295 = Math.PI / 180
    lat1 *= 0.017453292519943295;
    lon2 *= 0.017453292519943295;
    lat2 *= 0.017453292519943295;
    // 12742 = Diam of earth in km (2 * 6371)
    return 12742 * Math.asin(Math.sqrt(((1 - Math.cos(lat2 - lat1)) + (1 - Math.cos(lon2 - lon1)) * Math.cos(lat1) * Math.cos(lat2)) / 2));
}

function checkForMicroDogLegs(selectedFeatures) {
    for (let idx = 0; idx < selectedFeatures.length; idx++) {
        if (selectedFeatures[idx].geometry.components.length > 2) {
            const fromNode = W.model.nodes.getObjectById(selectedFeatures[idx].model.attributes.fromNodeID),
                toNode = W.model.nodes.getObjectById(selectedFeatures[idx].model.attributes.toNodeID);
            for (let idx2 = 0; idx2 < selectedFeatures[idx].geometry.components.length; idx2++) {
                const fromNode4326 = WazeWrap.Geometry.ConvertTo4326(fromNode.geometry.x, fromNode.geometry.y),
                    toNode4326 = WazeWrap.Geometry.ConvertTo4326(toNode.geometry.x, toNode.geometry.y),
                    testNode4326 = WazeWrap.Geometry.ConvertTo4326(selectedFeatures[idx].geometry.components[idx2].x, selectedFeatures[idx].geometry.components[idx2].y);
                if (((testNode4326.lon === fromNode4326.lon) && (testNode4326.lat === fromNode4326.lat)) || ((testNode4326.lon === toNode4326.lon) && (testNode4326.lat === toNode4326.lat)))
                    // eslint-disable-next-line no-continue
                    continue;
                if ((distanceBetweenPointsInKM(fromNode4326.lon, fromNode4326.lat, testNode4326.lon, testNode4326.lat) * 1000) < 2)
                    return true;
                if ((distanceBetweenPointsInKM(toNode4326.lon, toNode4326.lat, testNode4326.lon, testNode4326.lat) * 1000) < 2)
                    return true;
            }
        }
    }
    return false;
}

function doStraightenSegments(sanityContinue, nonContinuousContinue, conflictingNamesContinue, microDogLegsContinue) {
    const selectedFeatures = W.selectionManager.getSelectedFeatures(),
        segmentSelection = W.selectionManager.getSegmentSelection();
    if (selectedFeatures.length > 1) {
        if ((selectedFeatures.length > 10) && !sanityContinue) {
            if (_settings.sanityCheck === 'error')
                return WazeWrap.Alerts.error(SCRIPT_NAME, I18n.t('wmesu.error.TooManySegments'));
            if (_settings.sanityCheck === 'warning') {
                return WazeWrap.Alerts.confirm(
                    SCRIPT_NAME,
                    I18n.t('wmesu.prompts.SanityCheckConfirm'),
                    () => { doStraightenSegments(true); },
                    () => { },
                    I18n.t('wmesu.common.Yes'),
                    I18n.t('wmesu.common.No')
                );
            }
            sanityContinue = true;
        }
        if ((segmentSelection.multipleConnectedComponents === true) && !nonContinuousContinue) {
            if (_settings.nonContinuousSelection === 'error')
                return WazeWrap.Alerts.error(SCRIPT_NAME, I18n.t('wmesu.error.NonContinuous'));
            if (_settings.nonContinuousSelection === 'warning') {
                return WazeWrap.Alerts.confirm(
                    SCRIPT_NAME,
                    I18n.t('wmesu.prompts.NonContinuousConfirm'),
                    () => { doStraightenSegments(sanityContinue, true); },
                    () => { },
                    I18n.t('wmesu.common.Yes'),
                    I18n.t('wmesu.common.No')
                );
            }
            nonContinuousContinue = true;
        }
        if (_settings.conflictingNames !== 'nowarning') {
            const continuousNames = checkNameContinuity(selectedFeatures);
            if (!continuousNames && !conflictingNamesContinue && (_settings.conflictingNames === 'error'))
                return WazeWrap.Alerts.error(SCRIPT_NAME, I18n.t('wmesu.error.ConflictingNames'));
            if (!continuousNames && !conflictingNamesContinue && (_settings.conflictingNames === 'warning')) {
                return WazeWrap.Alerts.confirm(
                    SCRIPT_NAME,
                    I18n.t('wmesu.prompts.ConflictingNamesConfirm'),
                    () => { doStraightenSegments(sanityContinue, nonContinuousContinue, true); },
                    () => { },
                    I18n.t('wmesu.common.Yes'),
                    I18n.t('wmesu.common.No')
                );
            }
            conflictingNamesContinue = true;
        }
        if (!microDogLegsContinue && (checkForMicroDogLegs(selectedFeatures) === true)) {
            return WazeWrap.Alerts.confirm(
                SCRIPT_NAME,
                I18n.t('wmesu.prompts.MicroDogLegsConfirm'),
                () => { doStraightenSegments(sanityContinue, nonContinuousContinue, conflictingNamesContinue, true); },
                () => { },
                I18n.t('wmesu.common.Yes'),
                I18n.t('wmesu.common.No')
            );
        }
        const allNodeIds = [],
            dupNodeIds = [];
        let endPointNodeIds;
        for (let idx = 0; idx < selectedFeatures.length; idx++) {
            allNodeIds.push(selectedFeatures[idx].model.attributes.fromNodeID);
            allNodeIds.push(selectedFeatures[idx].model.attributes.toNodeID);
            if (selectedFeatures[idx].model.type === 'segment') {
                const newGeo = selectedFeatures[idx].model.geometry.clone();
                // Remove the geometry nodes
                if (newGeo.components.length > 2) {
                    newGeo.components.splice(1, newGeo.components.length - 2);
                    newGeo.components[0].calculateBounds();
                    newGeo.components[1].calculateBounds();
                    W.model.actionManager.add(new _updateSegmentGeometry(selectedFeatures[idx].model, selectedFeatures[idx].model.geometry, newGeo));
                    logDebug(`${I18n.t('wmesu.log.RemovedGeometryNodes')} # ${selectedFeatures[idx].model.attributes.id}`);
                }
            }
        }
        allNodeIds.forEach((nodeId, idx) => {
            if (allNodeIds.indexOf(nodeId, idx + 1) > -1) {
                if (dupNodeIds.indexOf(nodeId) === -1)
                    dupNodeIds.push(nodeId);
            }
        });
        const distinctNodes = [...new Set(allNodeIds)];
        if (segmentSelection.multipleConnectedComponents === false)
            endPointNodeIds = distinctNodes.filter(nodeId => !dupNodeIds.includes(nodeId));
        else
            endPointNodeIds = [selectedFeatures[0].model.attributes.fromNodeID, selectedFeatures[(selectedFeatures.length - 1)].model.attributes.toNodeID];
        logDebug(`${I18n.t('wmesu.log.StraighteningSegments')}: ${distinctNodes.join(', ')} (${distinctNodes.length})`);
        const endPointNodeObjs = W.model.nodes.getByIds(endPointNodeIds),
            endPointNode1Geo = endPointNodeObjs[0].geometry.clone(),
            endPointNode2Geo = endPointNodeObjs[1].geometry.clone();
        if (getDeltaDirect(endPointNode1Geo.x, endPointNode2Geo.x) < 0) {
            let t = endPointNode1Geo.x;
            endPointNode1Geo.x = endPointNode2Geo.x;
            endPointNode2Geo.x = t;
            t = endPointNode1Geo.y;
            endPointNode1Geo.y = endPointNode2Geo.y;
            endPointNode2Geo.y = t;
            endPointNodeIds.push(endPointNodeIds[0]);
            endPointNodeIds.splice(0, 1);
            endPointNodeObjs.push(endPointNodeObjs[0]);
            endPointNodeObjs.splice(0, 1);
        }
        logDebug(`${I18n.t('wmesu.log.EndPoints')}: ${endPointNodeIds.join(' & ')}`);
        const a = endPointNode2Geo.y - endPointNode1Geo.y,
            b = endPointNode1Geo.x - endPointNode2Geo.x,
            c = endPointNode2Geo.x * endPointNode1Geo.y - endPointNode1Geo.x * endPointNode2Geo.y;
        distinctNodes.forEach(nodeId => {
            if (endPointNodeIds.indexOf(nodeId) === -1) {
                const node = W.model.nodes.getObjectById(nodeId),
                    nodeGeo = node.geometry.clone();
                const d = nodeGeo.y * a - nodeGeo.x * b,
                    r1 = getIntersectCoord(a, b, c, d);
                nodeGeo.x = r1.x;
                nodeGeo.y = r1.y;
                nodeGeo.calculateBounds();
                const connectedSegObjs = {};
                for (let idx = 0; idx < node.attributes.segIDs.length; idx++) {
                    const segId = node.attributes.segIDs[idx];
                    connectedSegObjs[segId] = W.model.segments.getObjectById(segId).geometry.clone();
                }
                logDebug(`${I18n.t('wmesu.log.MovingJunctionNode')} # ${nodeId} `
                    + `- ${I18n.t('wmesu.common.From')}: ${node.geometry.x},${node.geometry.y} - `
                    + `${I18n.t('wmesu.common.To')}: ${r1.x},${r1.y}`);
                W.model.actionManager.add(new _moveNode(node, node.geometry, nodeGeo, connectedSegObjs, {}));
            }
        });
    } // W.selectionManager.selectedItems.length > 0
    else if (selectedFeatures.length === 1) {
        const seg = selectedFeatures[0],
            { model } = seg;
        if (model.type === 'segment') {
            const newGeo = model.geometry.clone();
            // Remove the geometry nodes
            if (newGeo.components.length > 2) {
                newGeo.components.splice(1, newGeo.components.length - 2);
                newGeo.components[0].calculateBounds();
                newGeo.components[1].calculateBounds();
                W.model.actionManager.add(new _updateSegmentGeometry(model, model.geometry, newGeo));
                logDebug(`${I18n.t('wmesu.log.RemovedGeometryNodes')} # ${model.attributes.id}`);
            }
        }
    }
    else {
        logWarning(I18n.t('wmesu.log.NoSegmentsSelected'));
    }
    return true;
}

function insertSimplifyStreetGeometryButtons() {
    $('.edit-restrictions').after(`<button id="WME-SU" class="waze-btn waze-btn-small waze-btn-white" title="${I18n.t('wmesu.StraightenUpTitle')}">${I18n.t('wmesu.StraightenUp')}</button>`);
}

function loadTranslations() {
    return new Promise(resolve => {
        const translations = {
                en: {
                    StraightenUp: 'Straighten up!',
                    StraightenUpTitle: 'Click here to straighten the selected segment(s) by removing geometry nodes and moving junction nodes as needed.',
                    common: {
                        From: 'from',
                        Help: 'Help',
                        No: 'No',
                        Note: 'Note',
                        NothingMajor: 'Nothing major.',
                        To: 'to',
                        Warning: 'Warning',
                        WhatsNew: 'What\'s new',
                        Yes: 'Yes'
                    },
                    error: {
                        ConflictingNames: 'You selected segments that do not share at least one name in common amongst all the segments and have the conflicting names setting set to error. '
                            + 'Segments not straightened.',
                        NonContinuousSelection: 'You selected segments that are not all connected and have the non-continuous selected segments setting set to give error. Segments not straightened.',
                        TooManySegments: 'You selected too many segments and have the sanity check setting set to give error. Segments not straightened.'
                    },
                    help: {
                        Note01: 'This script uses the action manager, so changes can be undone before saving.',
                        Warning01: 'Enabling (Give warning, No warning) any of these settings can cause unexpected results. Use with caution!',
                        Step01: 'Select the starting segment.',
                        Step02: 'ALT+click the ending segment.',
                        Step02note: 'If the segments you wanted to straighten are not all selected, unselect them and start over using CTRL+click to select each segment instead.',
                        Step03: 'Click "Straighten up!" button in the sidebar.'
                    },
                    log: {
                        EndPoints: 'End points',
                        MovingJunctionNode: 'Moving junction node',
                        NoSegmentsSelected: 'No segments selected.',
                        RemovedGeometryNodes: 'Removed geometry nodes for segment',
                        Segment: I18n.t('objects.segment.name'),
                        StraighteningSegments: 'Straightening segments'
                    },
                    prompts: {
                        ConflictingNamesConfirm: 'You selected segments that do not share at least one name in common amongst all the segments. Are you sure you wish to continue straightening?',
                        MicroDogLegsConfirm: 'One or more of the segments you selected have a geonode within 2 meters of the junction node. This is usually the sign of a micro dog leg (mDL).<br><br>'
                        + '<b>You should not continue until you are certain there are no micro dog legs.<b><br><br>'
                        + 'Are you sure you wish to continue straightening?',
                        NonContinuousConfirm: 'You selected segments that do not all connect. Are you sure you wish to continue straightening?',
                        SanityCheckConfirm: 'You selected many segments. Are you sure you wish to continue straightening?'
                    },
                    settings: {
                        GiveError: 'Give error',
                        GiveWarning: 'Give warning',
                        NoWarning: 'No warning',
                        ConflictingNames: 'Segments with conflicting names',
                        ConflictingNamesTitle: 'Select what to do if the selected segments do not share at least one name among their primary and alternate names (based on name, city and state).',
                        NonContinuous: 'Non-continuous selected segments',
                        NonContinuousTitle: 'Select what to do if the selected segments are not continuous.',
                        SanityCheck: 'Sanity check',
                        SanityCheckTitle: 'Select what to do if you selected a many segments.'
                    }
                },
                ru: {
                    SimplifyGeometry: 'Выровнять улицу',
                    log: {
                        EndPoints: 'конечные точки',
                        Segment: I18n.t('objects.segment.name')
                    }
                }
            },
            locale = I18n.currentLocale(),
            availTranslations = Object.keys(translations);
        I18n.translations[locale].wmesu = translations.en;
        if (availTranslations.indexOf(I18n.currentLocale()) > 0) {
            Object.keys(translations[locale]).forEach(prop => {
                if (typeof translations[locale][prop] === 'object') {
                    Object.keys(translations[locale][prop]).forEach(subProp => {
                        if (translations[locale][prop][subProp] !== '')
                            I18n.translations[locale].wmesu[prop][subProp] = translations[locale][prop][subProp];
                    });
                }
                else if (translations[locale][prop] !== '') {
                    I18n.translations[locale].wmesu[prop] = translations[locale][prop];
                }
            });
        }
        resolve();
    });
}

function registerEvents() {
    $('#WMESU-conflictingNames, #WMESU-nonContinuousSelection, #WMESU-sanityCheck').off().on('change', function () {
        const setting = this.id.substr(7);
        if (this.value.toLowerCase() !== _settings[setting]) {
            _settings[setting] = this.value.toLowerCase();
            saveSettingsToStorage();
        }
    });
}

function buildSelections(selected) {
    const rVal = `<option value="nowarning"${(selected === 'nowarning' ? ' selected' : '')}>${I18n.t('wmesu.settings.NoWarning')}</option>`
    + `<option value="warning"${(selected === 'warning' ? ' selected' : '')}>${I18n.t('wmesu.settings.GiveWarning')}</option>`
    + `<option value="error"${(selected === 'error' ? ' selected' : '')}>${I18n.t('wmesu.settings.GiveError')}</option>`;
    return rVal;
}

async function init() {
    log('Initializing.');
    if (W.loginManager.getUserRank() < 2)
        return;
    await loadSettingsFromStorage();
    await loadTranslations();
    const $suTab = $('<div>', { style: 'padding:8px 16px', id: 'WMESUSettings' });
    $suTab.html([
        `<div style="margin-bottom:0px;font-size:13px;font-weight:600;">${SCRIPT_NAME}</div>`,
        `<div style="margin-top:0px;font-size:11px;font-weight:600;color:#aaa">${SCRIPT_VERSION}</div>`,
        `<div id="WMESU-div-conflictingNames" class="controls-container"><select id="WMESU-conflictingNames" style="font-size:11px;height:22px;" title="${I18n.t('wmesu.settings.ConflictingNamesTitle')}">`,
        buildSelections(_settings.conflictingNames),
        `</select><div style="display:inline-block;font-size:11px;">${I18n.t('wmesu.settings.ConflictingNames')}</div>`,
        '</div><br/>',
        `<div id="WMESU-div-nonContinuousSelection" class="controls-container"><select id="WMESU-nonContinuousSelection" style="font-size:11px;height:22px;" title="${I18n.t('wmesu.settings.NonContinuousTitle')}">`,
        buildSelections(_settings.nonContinuousSelection),
        `</select><div style="display:inline-block;font-size:11px;">${I18n.t('wmesu.settings.NonContinuous')}</div>`,
        '</div><br/>',
        `<div id="WMESU-div-sanityCheck" class="controls-container"><select id="WMESU-sanityCheck" style="font-size:11px;height:22px;" title="${I18n.t('wmesu.settings.SanityCheckTitle')}">`,
        buildSelections(_settings.sanityCheck),
        `</select><div style="display:inline-block;font-size:11px;">${I18n.t('wmesu.settings.SanityCheck')}</div>`,
        `<div style="margin-top:20px;"><div style="font-size:14px;font-weight:600;">${I18n.t('wmesu.common.Help')}:</div><div><ol style="font-weight:600;">`,
        `<li><p style="font-weight:100;margin-bottom:0px;">${I18n.t('wmesu.help.Step01')}</p></li>`,
        `<li><p style="font-weight:100;margin-bottom:0px;">${I18n.t('wmesu.help.Step02')}<br><b>${I18n.t('wmesu.common.Note')}:</b> ${I18n.t('wmesu.help.Step02note')}</p></li>`,
        `<li><p style="font-weight:100;margin-bottom:0px;">${I18n.t('wmesu.help.Step03')}</p></li></ol></div>`,
        `<b>${I18n.t('wmesu.common.Warning')}:</b> ${I18n.t('wmesu.help.Warning01')}<br><br><b>${I18n.t('wmesu.common.Note')}:</b> ${I18n.t('wmesu.help.Note01')}</div></div>`
    ].join(' '));
    new WazeWrap.Interface.Tab('SU!', $suTab.html(), registerEvents);
    _updateSegmentGeometry = require('Waze/Action/UpdateSegmentGeometry');
    _moveNode = require('Waze/Action/MoveNode');
    W.selectionManager.events.register('selectionchanged', null, insertSimplifyStreetGeometryButtons);
    $('#sidebar').on('click', '#WME-SU', e => {
        e.preventDefault();
        doStraightenSegments();
    });
    showScriptInfoAlert();
    log(`Fully initialized in ${Math.round(performance.now() - LOAD_BEGIN_TIME)} ms.`);
}

function bootstrap(tries) {
    if (W && W.map && W.model && $ && WazeWrap.Ready) {
        checkTimeout({ timeout: 'bootstrap' });
        log('Bootstrapping.');
        init();
    }
    else if (tries < 1000) {
        logDebug(`Bootstrap failed. Retrying ${tries} of 1000`);
        _timeouts.bootstrap = window.setTimeout(bootstrap, 200, ++tries);
    }
    else {
        logError('Bootstrap timed out waiting for WME to become ready.');
    }
}

bootstrap(1);