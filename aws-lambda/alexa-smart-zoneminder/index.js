/**
 * Lambda function for Zoneminder control and status triggered by Alexa.
 * 
 * For details see https://github.com/goruck.
 * 
 * Copyright (c) 2018 Lindo St. Angel
 */

//==============================================================================
//========================== Setup and Globals  ================================
//==============================================================================
'use strict';
const fs = require('fs');
const Alexa = require('alexa-sdk');

// Get configuration. 
let file = fs.readFileSync('./config.json');
const configObj = safelyParseJSON(file);
if (configObj === null) {
    process.exit(1); // TODO: find a better way to exit. 
}

// Get credentials.
file = fs.readFileSync('./creds.json');
const credsObj = safelyParseJSON(file);
if (credsObj === null) {
    process.exit(1); // TODO: find a better way to exit. 
}

// Define some constants.
// TODO - clean this up.
const APP_ID = credsObj.alexaAppId;
const S3Path = 'https://s3-' + configObj.awsRegion +
    '.amazonaws.com/' + configObj.zmS3Bucket + '/';
const localPath = 'https://cam.lsacam.com:9443';
const USE_LOCAL_PATH = true;

// Help messages.
const helpMessages = ['Show Last Event',
    'Show Last Video',
    'Show Event from front porch',
    'Show Events from back porch Monday at 10 AM',
    'Show Video from back yard',
    'Show Videos from East last week Friday at 3 PM'];

// Holds list items that can be selected on the display or by voice.
let listItems = [];

//==============================================================================
//========================== Event Handlers  ===================================
//==============================================================================
const handlers = {
    'LaunchRequest': function () {
        log('INFO', `LaunchRequest Event: ${JSON.stringify(this.event)}`);

        let sessionAttributes = this.event.session.attributes;

        const welcomeOutput = 'Welcome to zoneminder!';
        const welcomeReprompt = `Say Show Last Event to view last alarm or say Show 
            Video to see a recording. You can also say Help to see example commands.`;

        // Check if user has a display.
        if (!supportsDisplay.call(this) && !isSimulator.call(this)) {
            this.emit(':ask', welcomeOutput, welcomeReprompt);
            return;
        }

        const content = {
            templateToken: 'ShowText',
            title: welcomeOutput,
            hasDisplaySpeechOutput: welcomeOutput,
            hasDisplayRepromptText: welcomeReprompt,
            bodyText: welcomeReprompt,
            backButton: 'HIDDEN',
            hint: 'help',
            askOrTell: ':ask',
            sessionAttributes: sessionAttributes
        };

        renderTemplate.call(this, content);
    },
    // Show last alarm from a camera or all cameras.
    'LastAlarm': function() {
        log('INFO', `LastAlarm Event: ${JSON.stringify(this.event)}`);

        let sessionAttributes = this.event.session.attributes;

        const cameraName = this.event.request.intent.slots.Location.value;
        log('INFO', `User supplied camera name: ${cameraName}`);

        // Determine if user wants latest alarm from a specific camera or from all cameras.
        let cameraConfigArray = [];
        if (typeof cameraName === 'undefined') { // latest alarm from all cameras
            cameraConfigArray = configObj.cameras;
        } else {
            // Check if user supplied a valid camera name and if so map to zoneminder name.
            const zoneminderCameraName = alexaCameraToZoneminderCamera(cameraName.toLowerCase());
            log('INFO', `ZM camera name: ${zoneminderCameraName}`);
            if (zoneminderCameraName === '') {
                log('ERROR', `Bad camera name: ${cameraName}`);
                this.response.speak('Sorry, I cannot find that camera name.');
                this.emit(':responseReady');
                return;
            }
            cameraConfigArray = [{zoneminderName: zoneminderCameraName}];
        }

        let queryResultArray = [];
        let queryCount = 0;

        // Use .forEach() to iterate since it creates its own function closure.
        // See https://stackoverflow.com/questions/11488014/asynchronous-process-inside-a-javascript-for-loop.
        const forEachCall = cameraConfigArray.forEach((element) => {
            findLatestAlarms(element.zoneminderName, null, null, 1, (err, data) => {
                if (err) {
                    log('ERROR', `Unable to query. ${JSON.stringify(err, null, 2)}`);
                    this.response.speak('Sorry, I cannot complete the request.');
                    this.emit(':responseReady');
                    return;
                }

                if (data.length !== 0) {
                    // Get latest alarm data from this camera.
                    let alarmData = data[0];
                    alarmData.zoneminderName = element.zoneminderName;
                    queryResultArray.push(alarmData);
                }

                queryCount++;

                if (queryCount < cameraConfigArray.length) return;

                // All queries finished, check if any alarms were found.
                if (queryResultArray.length === 0) {
                    this.response.speak('No alarms were found.');
                    this.emit(':responseReady');
                    return;
                }

                // Sort all alarms by datetime in descending order.
                queryResultArray.sort((a, b) => {
                    const dateTimeA = new Date(a.ZmEventDateTime);
                    const dateTimeB = new Date(b.ZmEventDateTime);
                            
                    if (dateTimeA < dateTimeB) return -1;

                    if (dateTimeA > dateTimeB) return 1;

                    // datetimes must be equal
                    return 0;
                });

                // Get alarm with latest datetime.
                const maxArrElem = queryResultArray.length - 1;
                const S3Key = queryResultArray[maxArrElem].S3Key;
                const ZmLocalEventPath = queryResultArray[maxArrElem].ZmLocalEventPath;
                const ZmEventDateTime = queryResultArray[maxArrElem].ZmEventDateTime;
                const ZmCameraName = queryResultArray[maxArrElem].zoneminderName;
                const ZmEventId = queryResultArray[maxArrElem].ZmEventId;
                const ZmFrameId = queryResultArray[maxArrElem].ZmFrameId;

                // Save alarm data to session attributes.
                sessionAttributes = {
                    S3Key: S3Key,
                    ZmLocalEventPath: ZmLocalEventPath,
                    ZmEventDateTime: ZmEventDateTime,
                    ZmCameraName: ZmCameraName,
                    ZmEventId: ZmEventId,
                    ZmFrameId: ZmFrameId
                };
                             
                // Check if user has a display and if not just return alarm info w/o image.
                if (!supportsDisplay.call(this) && !isSimulator.call(this)) {
                    const speechOutput = 'Last alarm was from '+ZmCameraName+' on '+
                            timeConverter(Date.parse(ZmEventDateTime));
                    this.response.speak(speechOutput);
                    this.emit(':responseReady');
                    return;
                }

                log('INFO', `S3 Key of latest alarm image: ${S3Key} from ${ZmEventDateTime}`);
                log('INFO', `Local Path of latest alarm image: ${ZmLocalEventPath} from ${ZmEventDateTime}`);

                // Check for valid image.
                if (typeof S3Key === 'undefined') {
                    log('ERROR', 'Bad image file');
                    this.response.speak('Sorry, I cannot complete the request.');
                    this.emit(':responseReady');
                    return;
                }

                const content = {
                    hasDisplaySpeechOutput: `Showing most recent alarm from ${ZmCameraName} camera.`,
                    hasDisplayRepromptText: 'You can ask zone minder for something else.',
                    bodyTemplateContent: timeConverter(Date.parse(ZmEventDateTime)),
                    title: `${ZmCameraName}`,
                    templateToken: 'ShowImage',
                    askOrTell: ':ask',
                    sessionAttributes: sessionAttributes
                };

                if (USE_LOCAL_PATH) {
                    content['backgroundImageUrl'] = localPath + ZmLocalEventPath;
                } else {
                    content['backgroundImageUrl'] = S3Path + S3Key;
                }

                renderTemplate.call(this, content);
            });
        });

        // Direct Alexa to say a wait message to user since operation may take a while.
        // This may reduce user perceived latency. 
        const waitMessage = 'Please wait.';
        const directiveServiceCall = callDirectiveService(this.event, waitMessage);
        Promise.all([directiveServiceCall, forEachCall]).then(() => {
            log('INFO', 'Generated images with interstitial content.');
        });
    },
    // Show a list of recent alarms on the screen for user selection.
    'Alarms': function() {
        log('INFO', `Alarm Events: ${JSON.stringify(this.event)}`);

        let sessionAttributes = this.event.session.attributes;

        // Check if user has a display.
        if (!supportsDisplay.call(this) && !isSimulator.call(this)) {
            const speechOutput = 'Sorry, I need a display to do that.';
            this.response.speak(speechOutput);
            this.emit(':responseReady');
            return;
        }

        const cameraName = this.event.request.intent.slots.Location.value;
        log('INFO', `User supplied camera name: ${cameraName}`);

        // Determine if user wants latest alarms from a specific camera or from all cameras.
        let cameraConfigArray = [];
        let numberOfAlarmsToFind = 0;
        if (typeof cameraName === 'undefined') { // latest alarms from all cameras
            cameraConfigArray = configObj.cameras;
            numberOfAlarmsToFind = 1;
        } else {
            // Check if user supplied a valid camera name and if so map to zoneminder name.
            const zoneminderCameraName = alexaCameraToZoneminderCamera(cameraName.toLowerCase());
            log('INFO', `ZM camera name: ${zoneminderCameraName}`);
            if (zoneminderCameraName === '') {
                log('ERROR', `Bad camera name: ${cameraName}`);
                this.response.speak('Sorry, I cannot find that camera name.');
                this.emit(':responseReady');
                return;
            }
            cameraConfigArray = [{zoneminderName: zoneminderCameraName}];
            numberOfAlarmsToFind = 10;
        }

        let queryCount = 0;
        let queryResultArray = [];
        const forEachCall = cameraConfigArray.forEach((element) => {
            findLatestAlarms(element.zoneminderName, null, null, numberOfAlarmsToFind, (err, data) => {
                if (err) {
                    log('ERROR', `Unable to query. ${JSON.stringify(err, null, 2)}`);
                    this.response.speak('Sorry, I cannot complete the request.');
                    this.emit(':responseReady');
                    return;
                }

                // Get latest alarm data from this camera.
                data.forEach(item => {
                    let alarmData = item;
                    alarmData.zoneminderName = element.zoneminderName;
                    queryResultArray.push(alarmData);
                });

                queryCount++;

                if (queryCount < cameraConfigArray.length) return;

                // All queries finished, check if any alarms were found.
                if (queryResultArray.length === 0) {
                    this.response.speak('No alarms were found.');
                    this.emit(':responseReady');
                    return;
                }

                // Sort all alarms by datetime in descending order.
                queryResultArray.sort((a, b) => {
                    const dateTimeA = new Date(a.ZmEventDateTime);
                    const dateTimeB = new Date(b.ZmEventDateTime);
                            
                    if (dateTimeA < dateTimeB) return -1;

                    if (dateTimeA > dateTimeB) return 1;

                    // datetimes must be equal
                    return 0;
                });

                let token = 1;
                listItems = [];
                queryResultArray.forEach((item) => {
                    //log('INFO', `S3Key: ${item.S3Key} ZmEventDateTime: ${item.ZmEventDateTime}`);
                    const datetime = timeConverter(Date.parse(item.ZmEventDateTime));
                    let imageUrl = '';
                    if (USE_LOCAL_PATH) {
                        imageUrl = localPath + item.ZmLocalEventPath;
                    } else {
                        imageUrl = S3Path + item.S3Key;
                    }
              
                    let listItem = {
                        'templateData': {
                            'token': token.toString(),
                            'image': {
                                'contentDescription': item.zoneminderName,
                                'sources': [
                                    {
                                        'url': imageUrl
                                    }
                                ]
                            },
                            'textContent': {
                                'primaryText': {
                                    'text': item.zoneminderName,
                                    'type': 'PlainText'
                                },
                                'secondaryText': {
                                    'text': datetime,
                                    'type': 'PlainText'
                                },
                                'tertiaryText': {
                                    'text': '',
                                    'type': 'PlainText'
                                }
                            }
                        },
                        'alarmData': item
                    };
                    listItems.push(listItem);
                    token++;
                });

                const content = {
                    hasDisplaySpeechOutput: 'Showing most recent alarms',
                    hasDisplayRepromptText: 'You can ask to see an alarm by number, or touch it.',
                    templateToken: 'ShowImageList',
                    askOrTell: ':ask',
                    listItems: listItems.map(obj => obj.templateData), // only include templateData
                    hint: 'select number 1',
                    title: 'Most recent alarms.',
                    sessionAttributes: sessionAttributes
                };
        
                renderTemplate.call(this, content);
            });
        });

        // Direct Alexa to say a wait message to user since operation may take a while.
        // This may reduce user perceived latency. 
        const waitMessage = 'Please wait.';
        const directiveServiceCall = callDirectiveService(this.event, waitMessage);
        Promise.all([directiveServiceCall, forEachCall]).then(() => {
            log('INFO', 'Generated images with interstitial content.');
        });
    },
    // Handle user selecting an item on the screen by touch.
    'ElementSelected': function() {
        log('INFO', `ElementSelected: ${JSON.stringify(this.event)}`);

        const item = parseInt(this.event.request.token, 10);
        const itemUrl = listItems[item - 1].templateData.image.sources[0].url;
        const itemDateTime = listItems[item - 1].templateData.textContent.primaryText.text;
        const content = {
            hasDisplaySpeechOutput: 'Showing selected alarm.',
            hasDisplayRepromptText: 'You can ask zone minder for something else.',
            bodyTemplateContent: itemDateTime,
            backgroundImageUrl: itemUrl,
            templateToken: 'ShowImage',
            askOrTell: ':ask',
            sessionAttributes: listItems[item - 1].alarmData // Save attributes to generate video later.
        };

        renderTemplate.call(this, content);
    },
    // Handle user selecting an item on the screen by voice.
    'SelectItem': function() {
        log('INFO', `SelectItem: ${JSON.stringify(this.event)}`);

        if (isNaN(this.event.request.intent.slots.number.value)) {
            log('ERROR', `Bad value. ${this.event.request.intent.slots.number.value}`);
            this.response.speak('Sorry, I cannot complete the request.');
            this.emit(':responseReady');
            return;
        }

        const item = parseInt(this.event.request.intent.slots.number.value, 10);
        const itemUrl = listItems[item - 1].templateData.image.sources[0].url;
        const itemDateTime = listItems[item - 1].templateData.textContent.primaryText.text;
        const content = {
            hasDisplaySpeechOutput: 'Showing selected alarm.',
            hasDisplayRepromptText: 'You can ask zone minder for something else.',
            bodyTemplateContent: itemDateTime,
            backgroundImageUrl: itemUrl,
            templateToken: 'ShowImage',
            askOrTell: ':ask',
            sessionAttributes: listItems[item - 1].alarmData // Save attributes to generate video later.
        };

        renderTemplate.call(this, content);
    },
    // Show video of an alarm.
    'AlarmClip': function() {
        log('INFO', `AMAZON.PlaybackAction: ${JSON.stringify(this.event)}`);

        let sessionAttributes = this.event.session.attributes;

        // Callback to pass to https call that generates alarm clip on server. 
        const showClipCallback = (err, resStr) => {
            if (err) {
                log('ERROR', `PlayBack httpsReq: ${err}`);
                this.response.speak('sorry, I can\'t complete the request');
                this.emit(':responseReady');
                return;
            }

            const result = safelyParseJSON(resStr);
            if (result === null || result.success === false) {
                log('ERROR', `Playback result: ${JSON.stringify(result)}`);
                this.response.speak('sorry, I cannot complete the request');
                this.emit(':responseReady');
                return;
            }

            const content = {
                hasDisplaySpeechOutput: 'Showing clip of selected alarm.',
                uri: credsObj.alarmVideoPath,
                title: 'Alarm Video',
                templateToken: 'ShowVideo',
                sessionAttributes: {} // clear session attributes
            };

            renderTemplate.call(this, content);
        };

        // Check if session attributes were set.
        // If they were then an alarm was just viewed and user wants to see video.
        // If not then skip this and process request normally. 
        if (Object.keys(sessionAttributes).length !== 0) {
            // Session contains latest alarm frame, event ID and datetime.
            const lastEvent = sessionAttributes.ZmEventId;
            const ZmEventDateTime = sessionAttributes.ZmEventDateTime;
            const lastFrame = sessionAttributes.ZmFrameId;
            // Number of frames before last frame to show in video. 
            const IN_SESSION_PRE_FRAMES = 100;
            let startFrame = 0;
            if (lastFrame > IN_SESSION_PRE_FRAMES) {
                startFrame = lastFrame - IN_SESSION_PRE_FRAMES;
            }
            // Number of frames after last frame to show in video.
            const IN_SESSION_POST_FRAMES = 100;
            const endFrame = lastFrame + IN_SESSION_POST_FRAMES;

            log('INFO', 'Showing video in session.');
            log('INFO', `Event ID of latest alarm image: ${lastEvent} from ${ZmEventDateTime}`);
            log('INFO', `Start Frame of latest alarm image: ${startFrame}`);
            log('INFO', `End Frame of latest alarm image: ${endFrame}`);

            const method   = 'GET';
            const path     = '/cgi/gen-vid.py?event='+lastEvent.toString()+
                             '&start_frame='+startFrame.toString()+'&end_frame='+endFrame.toString();
            const postData = '';
            const text     = true;
            const user     = credsObj.cgiUser;
            const pass     = credsObj.cgiPass;
            const httpsCall = httpsReq(method, path, postData, text, user, pass, showClipCallback);

            // Direct Alexa to say a wait message to user since operation may take a while.
            // This may reduce user perceived latency.
            const waitMessage = 'Please wait.';
            const directiveServiceCall = callDirectiveService(this.event, waitMessage);
            Promise.all([directiveServiceCall, httpsCall]).then(() => {
                log('INFO', 'Generated video with interstitial content.');
            });

            return;
        }

        // Delegate to Alexa for camera location slot confirmation.
        let delegateState = delegateToAlexa.call(this);
        if (delegateState == null) return;

        const cameraName = this.event.request.intent.slots.Location.value;

        // Check if user supplied a valid camera name and if so map to zoneminder name.
        const zoneminderCameraName = alexaCameraToZoneminderCamera(cameraName.toLowerCase());
        log('INFO', `ZM camera name: ${zoneminderCameraName}`);
        if (zoneminderCameraName === '') {
            log('ERROR', `Bad camera name: ${cameraName}`);
            this.response.speak('Sorry, I cannot find that camera name.');
            this.emit(':responseReady');
            return;
        }

        // How far back to go to find first alarm for given camera. 
        const NUM_RECORDS_TO_QUERY = 100;
        findLatestAlarms(zoneminderCameraName, null, null, NUM_RECORDS_TO_QUERY, (err, data) => {
            if (err) {
                log('ERROR', `Unable to query. ${JSON.stringify(err, null, 2)}`);
                this.response.speak('Sorry, I cannot complete the request.');
                this.emit(':responseReady');
                return;
            }

            if (data.length === 0) {
                this.response.speak('No alarms were found.');
                this.emit(':responseReady');
                return;
            }

            // Check if user has a display and if not return error message.
            if (!supportsDisplay.call(this) && !isSimulator.call(this)) {
                const speechOutput = 'Sorry, I cannot play video on this device';
                this.response.speak(speechOutput);
                this.emit(':responseReady');
                return;
            }

            // Get event id and last frame id of latest alarm.
            const lastEvent = data[0].ZmEventId;
            let endFrame = data[0].ZmFrameId;
            
            // Find the first frame id of the last event.
            let startFrame = 0;
            data.forEach((alarm) => {
                if (alarm.ZmEventId === lastEvent) {
                    startFrame = alarm.ZmFrameId;
                }
            });

            // Pad clip to make sure it not too short. 
            if (startFrame < 20) {
                startFrame -= startFrame;
            } else {
                startFrame -= 20;
            }

            if (endFrame < 20) {
                endFrame += endFrame;
            } else {
                endFrame += 20;
            }

            // Limit clip to make sure its not too long. 
            if ((endFrame - startFrame) > 500) {
                endFrame = startFrame + 500;
                log('INFO', 'Limited duration of clip to 500 frames.');
            }

            const ZmEventDateTime = data[0].ZmEventDateTime;
            log('INFO', `Event ID of latest alarm image: ${lastEvent} from ${ZmEventDateTime}`);
            log('INFO', `Start Frame of latest alarm image: ${startFrame}`);
            log('INFO', `End Frame of latest alarm image: ${endFrame}`);

            const method   = 'GET';
            const path     = '/cgi/gen-vid.py?event='+lastEvent.toString()+
                             '&start_frame='+startFrame.toString()+'&end_frame='+endFrame.toString();
            const postData = '';
            const text     = true;
            const user     = credsObj.cgiUser;
            const pass     = credsObj.cgiPass;
            const httpsCall = httpsReq(method, path, postData, text, user, pass, showClipCallback);

            // Direct Alexa to say a wait message to user since operation may take a while.
            // This may reduce user perceived latency.
            const waitMessage = 'Please wait.';
            const directiveServiceCall = callDirectiveService(this.event, waitMessage);
            Promise.all([directiveServiceCall, httpsCall]).then(() => {
                log('INFO', 'Generated video with interstitial content.');
            });
        });
    },
    // Show a person based on face recognition.
    'Faces': function() {
        log('INFO', `Faces Event: ${JSON.stringify(this.event)}`);

        let sessionAttributes = this.event.session.attributes;

        // Check if user has a display.
        if (!supportsDisplay.call(this) && !isSimulator.call(this)) {
            const speechOutput = 'Sorry, I need a display to do that.';
            this.response.speak(speechOutput);
            this.emit(':responseReady');
            return;
        }

        // Get camera name and face name from slots.
        const cameraName = this.event.request.intent.slots.Location.value;
        log('INFO', `User supplied camera name: ${cameraName}`);
        if (typeof cameraName === undefined) {
            log('ERROR', 'cameraName is undefined.');
            this.response.speak('Sorry, I cannot complete the request.');
            this.emit(':responseReady');
            return;
        }
        let faceName = this.event.request.intent.slots.Name.value;
        log('INFO', `User supplied face name: ${faceName}`);
        if (typeof(faceName) === 'undefined') {
            log('ERROR', 'faceName is undefined.');
            this.response.speak('Sorry, I cannot complete the request.');
            this.emit(':responseReady');
            return;
        }

        // Check if user supplied a valid camera name and if so map to zoneminder name.
        const zoneminderCameraName = alexaCameraToZoneminderCamera(cameraName.toLowerCase());
        log('INFO', `ZM camera name: ${zoneminderCameraName}`);
        if (zoneminderCameraName === '') {
            log('ERROR', `Bad camera name: ${cameraName}`);
            this.response.speak('Sorry, I cannot find that camera name.');
            this.emit(':responseReady');
            return;
        }

        // Check if user supplied a valid name and if so map to a database name.
        const databaseName = alexaFaceNameToDatabaseName(faceName.toLowerCase());
        log('INFO', `database face name: ${databaseName}`);

        let findFaceName = null;
        let findObjectName = null;

        if (databaseName === 'Unknown') {
            // Look for Unknown faces in database. 
            faceName = 'stranger';
            findFaceName = databaseName;
        } else if (databaseName === 'dog') {
            // Temp hack to show the dog.
            findObjectName = databaseName;
        } else {
            findFaceName = databaseName;
        }

        findLatestAlarms(zoneminderCameraName, findFaceName, findObjectName, 10, (err, data) => {
            if (err) {
                log('ERROR', `Unable to query. ${JSON.stringify(err, null, 2)}`);
                this.response.speak('Sorry, I cannot complete the request.');
                this.emit(':responseReady');
                return;
            }

            if (data.length === 0) {
                this.response.speak('No alarms were found.');
                this.emit(':responseReady');
                return;
            }

            let jsonData = {};
            let token = 1;
            listItems = [];

            data.forEach((item) => {
                log('INFO', `S3Key: ${item.S3Key}
                    ZmEventDateTime: ${item.ZmEventDateTime} Labels ${item.Labels}`);
                const datetime = timeConverter(Date.parse(item.ZmEventDateTime));
                let imageUrl = '';
                if (USE_LOCAL_PATH) {
                    imageUrl = localPath + item.ZmLocalEventPath;
                } else {
                    imageUrl = S3Path + item.S3Key;
                }
              
                jsonData = {
                    'token': token.toString(),
                    'image': {
                        'contentDescription': cameraName,
                        'sources': [
                            {
                                'url': imageUrl
                            }
                        ]
                    },
                    'textContent': {
                        'primaryText': {
                            'text': datetime,
                            'type': 'PlainText'
                        },
                        'secondaryText': {
                            'text': '',
                            'type': 'PlainText'
                        },
                        'tertiaryText': {
                            'text': '',
                            'type': 'PlainText'
                        }
                    }
                };

                listItems.push(jsonData);

                token++;
            });

            const content = {
                hasDisplaySpeechOutput: `Showing most recent alarms from ${cameraName} for ${faceName}`,
                hasDisplayRepromptText: 'You can ask zone minder for something else.',
                templateToken: 'ShowImageList',
                askOrTell: ':ask',
                listItems: listItems,
                hint: 'select number 1',
                title: `Most recent alarms from ${cameraName} for ${faceName}.`,
                sessionAttributes: sessionAttributes
            };

            renderTemplate.call(this, content);
        });
    },
    'AMAZON.HelpIntent': function () {
        console.log('Help event: ' + JSON.stringify(this.event));

        // If user does not have a display then only provide audio help. 
        if (!supportsDisplay.call(this) && !isSimulator.call(this)) {
            const helpOutput = `Here are some example commands ${helpMessages.join(' ')}`;
            const helpReprompt = 'Please say a command.';
            this.emit(':ask', helpOutput, helpReprompt);
            return;
        }

        const helpText = `Here are some example commands: ${helpMessages.join()}`;

        const content = {
            templateToken: 'ShowText',
            title: 'zoneminder help',
            bodyText: helpText,
            hasDisplaySpeechOutput: 'Here are some example commands you can say.',
            hasDisplayRepromptText: 'Please say a command.',
            backButton: 'HIDDEN',
            hint: 'help',
            askOrTell: ':ask',
            sessionAttributes: this.attributes
        };

        renderTemplate.call(this, content);
    },
    'AMAZON.CancelIntent': function () {
        console.log('Cancel event: ' + JSON.stringify(this.event));
        const speechOutput = 'goodbye';
        this.response.speak(speechOutput);
        this.emit(':responseReady');
        return;
    },
    'AMAZON.StopIntent': function () {
        console.log('Stop event: ' + JSON.stringify(this.event));
        const speechOutput = 'goodbye';
        this.response.speak(speechOutput);
        this.emit(':responseReady');
        return;
    },
    'SessionEndedRequest': function () {
        console.log('Session ended event: ' + JSON.stringify(this.event));
        const speechOutput = 'goodbye';
        this.response.speak(speechOutput);
        this.emit(':responseReady');
        return;
    },
    'Unhandled': function() {
        console.log('Unhandled event: ' + JSON.stringify(this.event));
        const speechOutput = 'Something went wrong. Goodbye.';
        this.response.speak(speechOutput);
        this.emit(':responseReady');
        return;
    }
};

exports.handler = (event, context) => {
    const alexa = Alexa.handler(event, context);
    alexa.appId = APP_ID;
    alexa.registerHandlers(handlers);
    alexa.execute();
};

//==============================================================================
//===================== Zoneminder Helper Functions  ===========================
//==============================================================================

/**
 * Mapping from Alexa returned camera names to zoneminder camera names.
 */
function alexaCameraToZoneminderCamera(alexaCameraName) {
    const cameraConfigArray = configObj.cameras;

    let zoneminderCameraName = '';

    cameraConfigArray.forEach((element) => {
        // True if a valid value was passed.
        let isValidCamera = element.friendlyNames.indexOf(alexaCameraName) > -1;
        if (isValidCamera) {
            zoneminderCameraName = element.zoneminderName;
        }
    });

    return zoneminderCameraName;
}

/**
 * Mapping from Alexa returned face names to database face names.
 */
function alexaFaceNameToDatabaseName(alexaFaceName) {
    const faceNamesArray = configObj.faces;

    // If a match was not found then look for Unknown faces in database.
    let databaseFaceName = 'Unknown';

    faceNamesArray.forEach((element) => {
        // True if a valid value was passed.
        let isValidFace = element.friendlyNames.indexOf(alexaFaceName) > -1;
        if (isValidFace) {
            databaseFaceName = element.databaseName;
        }
    });

    return databaseFaceName;
}

/**
 * Callback for findLatestAlarms.
 *
 * @callback latestAlarmCallback
 * @param {string} err - An error message.
 * @param {array} foundAlarms - An array holding found alarms.
 * 
 */
/**
 * Find most recent alarm frames for a given camera name.
 * 
 * @param {string} cameraName - ZoneMinder monitor name to search over.
 * @param {string} faceName - Name of a person to search for.
 * @param {string} objectName - Name of an object to search for.
 * @param {int} numberOfAlarms - Number of alarm frames to find.
 * @param {latestAlarmCallback} callback - callback fn, returns array of found alarms.
 */
function findLatestAlarms(cameraName, faceName, objectName, numberOfAlarms, callback) {
    const docClient = new AWS.DynamoDB.DocumentClient(
        {apiVersion: '2012-10-08', region: configObj.awsRegion}
    );

    // Base query looks for true false positives from a named camera.
    // If faceName or objectName is null then any person or object will queried for. 
    let filterExpression = 'Alert = :state';
    let projectionExpression = 'ZmEventDateTime, S3Key, ZmEventId, ZmFrameId, ZmLocalEventPath';
    const expressionAttributeValues = {
        ':name': cameraName,
        ':state': 'true'
    };

    // If a face name was provided then add it to query.
    // If face provided then objectName is ignored (it has to be a person).
    if (faceName !== null) {
        projectionExpression += ', Labels';
        filterExpression += ' AND contains(Labels, :face)';
        expressionAttributeValues[':face'] = faceName;
    } else if (objectName !== null) {
        projectionExpression += ', Labels';
        filterExpression += ' AND contains(Labels, :object)';
        expressionAttributeValues[':object'] = objectName;
    }

    let params = {
        TableName: 'ZmAlarmFrames',
        ScanIndexForward: false, // Descending sort order.
        ProjectionExpression: projectionExpression,
        KeyConditionExpression: 'ZmCameraName = :name',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionAttributeValues
    };

    let foundAlarms = [];
    let foundAlarmCount = 0;
                    
    function queryExecute() {
        docClient.query(params, (err, data) => {
            if (err) {
                return callback(err, null);
            }
      
            // If a query was successful then add to list.
            for (const item of data.Items) {
                foundAlarms.push(item);
                foundAlarmCount++;
                if (foundAlarmCount === numberOfAlarms) {
                    return callback(null, foundAlarms);
                }
            }

            // Query again if there are more records.
            // Else return what was found so far (if anything).
            if (data.LastEvaluatedKey) {
                params.ExclusiveStartKey = data.LastEvaluatedKey;
                queryExecute();
            } else {
                return callback(null, foundAlarms);
            }
        });
    }    
                    
    queryExecute();
}

//==============================================================================
//============= Alexa Progressive Response Helper Functions  ===================
//==============================================================================
function callDirectiveService(event, message) {
    // Instantiate Alexa Directive Service
    const ds = new Alexa.services.DirectiveService();
    // Extract Variables
    const requestId = event.request.requestId;
    const endpoint = event.context.System.apiEndpoint;
    const token = event.context.System.apiAccessToken;
    // Instantiate Progressive Response Directive
    const directive = new Alexa.directives.VoicePlayerSpeakDirective(requestId, message);
    // Store functions as data in queue
    return ds.enqueue(directive, endpoint, token);
}

//==============================================================================
//==================== Alexa Delegate Helper Functions  ========================
//==============================================================================
function delegateToAlexa() {
    //console.log("in delegateToAlexa");
    //console.log("current dialogState: "+ this.event.request.dialogState);

    if (this.event.request.dialogState === 'STARTED') {
        //console.log("in dialog state STARTED");
        const updatedIntent = this.event.request.intent;
        //optionally pre-fill slots: update the intent object with slot values for which
        //you have defaults, then return Dialog.Delegate with this updated intent
        // in the updatedIntent property
        this.emit(':delegate', updatedIntent);
    } else if (this.event.request.dialogState !== 'COMPLETED') {
        //console.log("in dialog state COMPLETED");
        // Return a Dialog.Delegate directive with no updatedIntent property
        this.emit(':delegate');
    } else {
        //console.log("dialog finished");
        //console.log("returning: "+ JSON.stringify(this.event.request.intent));
        // Dialog is now complete and all required slots should be filled,
        // so call your normal intent handler.
        return this.event.request.intent;
    }
}

//==============================================================================
//============================ S3 Helper Functions  ============================
//==============================================================================
var AWS = require('aws-sdk');
var s3 = new AWS.S3();

// Get file from S3
function getS3File(bucketName, fileName, versionId, callback) {
    var params = {
        Bucket: bucketName,
        Key: fileName
    };
    if (versionId) {
        params.VersionId = versionId;
    }
    s3.getObject(params, function (err, data) {
        callback(err, data);
    });
}

// Put file into S3
function putS3File(bucketName, fileName, data, callback) {
    var expirationDate = new Date();
    // Assuming a user would not remain active in the same session for over 1 hr.
    expirationDate = new Date(expirationDate.setHours(expirationDate.getHours() + 1));
    var params = {
        Bucket: bucketName,
        Key: fileName,
        Body: data,
        ACL: 'public-read', // TODO: find way to restrict access to this lambda function
        Expires: expirationDate
    };
    s3.putObject(params, function (err, data) {
        callback(err, data);
    });
}

// Upload object to S3
function uploadS3File(bucketName, fileName, data, callback) {
    var params = {
        Bucket: bucketName,
        Key: fileName,
        Body: data,
        ACL: 'public-read', // TODO: find way to restrict access to this lambda function
    };
    s3.upload(params, function(err, data) {
        callback(err, data);
    });
}

//==============================================================================
//===================== Echo Show Helper Functions  ============================
//==============================================================================
function supportsDisplay() {
    var hasDisplay =
    this.event.context &&
    this.event.context.System &&
    this.event.context.System.device &&
    this.event.context.System.device.supportedInterfaces &&
    this.event.context.System.device.supportedInterfaces.Display;

    return hasDisplay;
}

function isSimulator() {
    var isSimulator = !this.event.context; //simulator doesn't send context
    return false;
}

function renderTemplate (content) {
    log('INFO', `renderTemplate ${content.templateToken}`);

    let response = {};
   
    switch(content.templateToken) {
    case 'ShowVideo':
        response = {
            'version': '1.0',
            'sessionAttributes': content.sessionAttributes,
            'response': {
                'outputSpeech': {
                    'type': 'SSML',
                    'ssml': '<speak>'+content.hasDisplaySpeechOutput+'</speak>'
                },
                'reprompt': null,
                'card': null, // TODO: get cards to work.
                'directives': [
                    {
                        'type': 'VideoApp.Launch',
                        'videoItem': {
                            'source': content.uri,
                            'metadata': {
                                'title': content.title,
                                'subtitle': ''
                            }
                        }
                    }
                ]
            }
        };
        // Send the response to Alexa.
        this.context.succeed(response);
        break;
    case 'ShowImageList':
        response = {
            'version': '1.0',
            'response': {
                'directives': [
                    {
                        'type': 'Display.RenderTemplate',
                        'template': {
                            'type': 'ListTemplate2',
                            'backButton': 'VISIBLE',
                            'title': content.title,
                            'token': content.templateToken,
                            'listItems': content.listItems
                        }
                    },
                    {
                        'type': 'Hint',
                        'hint': {
                            'type': 'PlainText',
                            'text': content.hint
                        }
                    }
                ],
                'outputSpeech': {
                    'type': 'SSML',
                    'ssml': '<speak>'+content.hasDisplaySpeechOutput+'</speak>'
                },
                'reprompt': {
                    'outputSpeech': {
                        'type': 'SSML',
                        'ssml': '<speak>'+content.hasDisplayRepromptText+'</speak>'
                    }
                },
                'card': null, // TODO: get cards to work.
                'shouldEndSession': content.askOrTell === ':tell'
            },
            'sessionAttributes': content.sessionAttributes
        };

        if(content.backgroundImageUrl) {
            let sources = [
                {
                    'url': content.backgroundImageUrl
                }
            ];
            response['response']['directives'][0]['template']['backgroundImage'] = {};
            response['response']['directives'][0]['template']['backgroundImage']['sources'] = sources;
        }

        // Send the response to Alexa.
        this.context.succeed(response);
        break;
    case 'ShowTextList':
        response = {
            'version': '1.0',
            'response': {
                'directives': [
                    {
                        'type': 'Display.RenderTemplate',
                        'template': {
                            'type': 'ListTemplate1',
                            'backButton': 'HIDDEN',
                            'title': content.title,
                            'token': content.templateToken,
                            'listItems': content.listItems
                        }
                    }
                ],
                'outputSpeech': {
                    'type': 'SSML',
                    'ssml': '<speak>'+content.hasDisplaySpeechOutput+'</speak>'
                },
                'reprompt': {
                    'outputSpeech': {
                        'type': 'SSML',
                        'ssml': '<speak>'+content.hasDisplayRepromptText+'</speak>'
                    }
                },
                'card': null, // TODO: get cards to work.
                'shouldEndSession': content.askOrTell === ':tell'
            },
            'sessionAttributes': content.sessionAttributes
        };

        if(content.backgroundImageUrl) {
            let sources = [
                {
                    'url': content.backgroundImageUrl
                }
            ];
            response['response']['directives'][0]['template']['backgroundImage'] = {};
            response['response']['directives'][0]['template']['backgroundImage']['sources'] = sources;
        }

        // Send the response to Alexa.
        this.context.succeed(response);
        break;
    case 'ShowImage':
        response = {
            'version': '1.0',
            'response': {
                'directives': [
                    {
                        'type': 'Display.RenderTemplate',
                        'template': {
                            'type': 'BodyTemplate6',
                            'backButton': 'VISIBLE',
                            'title': content.title,
                            'token': content.templateToken,
                            'textContent': {
                                'primaryText': {
                                    'type': 'RichText',
                                    'text': '<font size = \'3\'>'+content.bodyTemplateContent+'</font>'
                                }
                            }
                        }
                    },
                    {
                        'type': 'Hint',
                        'hint': {
                            'type': 'PlainText',
                            'text': content.hint
                        }
                    }
                ],
                'outputSpeech': {
                    'type': 'SSML',
                    'ssml': '<speak>'+content.hasDisplaySpeechOutput+'</speak>'
                },
                'reprompt': {
                    'outputSpeech': {
                        'type': 'SSML',
                        'ssml': '<speak>'+content.hasDisplayRepromptText+'</speak>'
                    }
                },
                'card': null, // TODO: get cards to work.
                'shouldEndSession': content.askOrTell === ':tell',
            },
            'sessionAttributes': content.sessionAttributes
        };

        if(content.backgroundImageUrl) {
            let sources = [
                {
                    'url': content.backgroundImageUrl
                }
            ];
            response['response']['directives'][0]['template']['backgroundImage'] = {};
            response['response']['directives'][0]['template']['backgroundImage']['sources'] = sources;
        }

        //Send the response to Alexa
        this.context.succeed(response);
        break;
    case 'ShowText':
        response = {
            'version': '1.0',
            'response': {
                'directives': [
                    {
                        'type': 'Display.RenderTemplate',
                        'template': {
                            'type': 'BodyTemplate1',
                            'backButton': content.backButton,
                            'title': content.title,
                            'token': content.templateToken,
                            'textContent': {
                                'primaryText': {
                                    'type': 'RichText',
                                    'text': '<font size = \'7\'>'+content.bodyText+'</font>'
                                }
                            }
                        }
                    },
                    {
                        'type': 'Hint',
                        'hint': {
                            'type': 'PlainText',
                            'text': content.hint
                        }
                    }
                ],
                'outputSpeech': {
                    'type': 'SSML',
                    'ssml': '<speak>'+content.hasDisplaySpeechOutput+'</speak>'
                },
                'reprompt': {
                    'outputSpeech': {
                        'type': 'SSML',
                        'ssml': '<speak>'+content.hasDisplayRepromptText+'</speak>'
                    }
                },
                'card': null, // TODO: get cards to work.
                'shouldEndSession': content.askOrTell === ':tell',
            },
            'sessionAttributes': content.sessionAttributes
        };

        if(content.backgroundImageUrl) {
            let sources = [
                {
                    'url': content.backgroundImageUrl
                }
            ];
            response['response']['directives'][0]['template']['backgroundImage'] = {};
            response['response']['directives'][0]['template']['backgroundImage']['sources'] = sources;
        }

        //Send the response to Alexa
        this.context.succeed(response);
        break;
    default:
        this.response.speak('Thanks for using zone minder, goodbye');
        this.emit(':responseReady');
    }
}

//==============================================================================
//======================== Misc Helper Functions  ==============================
//==============================================================================
/*
 *
 */
var httpsReq = (method, path, postData, text, user, pass, callback) => {
    // If environment variables for host and port exist then override configuration. 
    let HOST = '';
    if (process.env.host) {
        HOST = process.env.host;
    } else {
        HOST = credsObj.host;
    }

    let PORT = '';
    if (process.env.port) {
        PORT = process.env.port;
    } else {
        PORT = credsObj.port;
    }

    /*var CERT = fs.readFileSync('./certs/client.crt'),
        KEY  = fs.readFileSync('./certs/client.key'),
        CA   = fs.readFileSync('./certs/ca.crt');*/

    var https = require('https'),
        Stream = require('stream').Transform,
        zlib = require('zlib');

    var options = {
        hostname: HOST,
        port: PORT,
        path: path,
        method: method,
        //rejectUnauthorized: true,
        //rejectUnauthorized: false,
        //key: KEY,
        //cert: CERT,
        //ca: CA,
        headers: {
            'Content-Type': (text ? 'application/json' : 'image/png'),
            'Content-Length': postData.length,
            'accept-encoding' : 'gzip,deflate'
        }
    };

    if (user && pass) {
        const auth = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
        options.headers.Authorization = auth;
    }

    var req = https.request(options, (result) => {
        const data = new Stream();
        data.setEncoding('utf8'); // else a buffer will be returned

        result.on('data', (chunk) => {
            data.push(chunk);
            //console.log("chunk: " +chunk);
        });

        result.on('end', () => {
            //console.log("STATUS: " + result.statusCode);
            //console.log("HEADERS: " + JSON.stringify(result.headers));

            var encoding = result.headers['content-encoding'];
            if (encoding == 'gzip') {
                zlib.gunzip(data.read(), function(err, decoded) {
                    callback(null, decoded); // TODO: add error handling.
                });
            } else if (encoding == 'deflate') {
                zlib.inflate(data.read(), function(err, decoded) {
                    callback(null, decoded);
                });
            } else {
                callback(null, data.read());
            }

            //callback(data.read());
        });
    });

    // Set timeout on socket inactivity. 
    req.on('socket', function (socket) {
        socket.setTimeout(45000); // 45 sec timeout. 
        socket.on('timeout', function() {
            req.abort();
        });
    });

    req.write(postData);

    req.end();

    req.on('error', (e) => {
        console.log('ERROR https request: ' + e.message);
        callback(e.message, null);
    });
};

/*
 * Converts Unix timestamp (in Zulu) in ms to human understandable date and time of day.
 */
function timeConverter(unix_timestamp) {
    //const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    // tzDiff = 8 * 60 * 60 * 1000 - Pacific time is 8 hours behind UTC (daylight savings).
    //const tzDiff = 28800000;
    // tzOiff = 7 * 60 * 60 * 1000. // standard time.
    // TODO: make this conversion more robust.
    const tzDiff = 25200000;
    // Create a new JavaScript Date object based on the timestamp.
    // Multiplied by 1000 so that the argument is in milliseconds, not seconds.
    let date = new Date(unix_timestamp - tzDiff);
    let year = date.getFullYear();
    //var month = months[date.getMonth()];
    let month = date.getMonth() + 1;
    let day = date.getDate();
    let hours = date.getHours();
    let minutes = '0' + date.getMinutes();
    let seconds = '0' + date.getSeconds();

    // Will display time in M D HH:MM format
    //var formattedTime = month + " " + day + " " + hours + ":" + minutes.substr(-2);
    // Will display in 2013-10-04 22:23:00 format
    let formattedTime = year+'-'+month+'-'+day+' '+hours+':'+minutes.substr(-2)+':'+seconds.substr(-2);
    return formattedTime;
}

/*
 * Parse ISO8501 duration string.
 * See https://stackoverflow.com/questions/27851832/how-do-i-parse-an-iso-8601-formatted-duration-using-moment-js
 *
 */
function parseISO8601Duration(durationString) {
    // regex to parse ISO8501 duration string.
    // TODO: optimize regex since it matches way more than needed.
    var iso8601DurationRegex = /P((([0-9]*\.?[0-9]*)Y)?(([0-9]*\.?[0-9]*)M)?(([0-9]*\.?[0-9]*)W)?(([0-9]*\.?[0-9]*)D)?)?(T(([0-9]*\.?[0-9]*)H)?(([0-9]*\.?[0-9]*)M)?(([0-9]*\.?[0-9]*)S)?)?/;

    var matches = durationString.match(iso8601DurationRegex);
    //console.log("parseISO8601Duration matches: " +matches);

    return {
        years: matches[3] === undefined ? 0 : parseInt(matches[3]),
        months: matches[5] === undefined ? 0 : parseInt(matches[5]),
        weeks: matches[7] === undefined ? 0 : parseInt(matches[7]),
        days: matches[9] === undefined ? 0 : parseInt(matches[9]),
        hours: matches[12] === undefined ? 0 : parseInt(matches[12]),
        minutes: matches[14] === undefined ? 0 : parseInt(matches[14]),
        seconds: matches[16] === undefined ? 0 : parseInt(matches[16])
    };
}

/*
 * Checks for valid JSON and parses it. 
 */
function safelyParseJSON(json) {
    try {
        return JSON.parse(json);
    } catch (e) {
        log('ERROR', `JSON parse error: ${e}`);
        return null;
    }
}

/*
 *
 */
function randomPhrase(array) {
    // the argument is an array [] of words or phrases
    var i = 0;
    i = Math.floor(Math.random() * array.length);
    return(array[i]);
}

/*
 *
 */
function isSlotValid(request, slotName){
    var slot = request.intent.slots[slotName];
    //console.log("request = "+JSON.stringify(request)); //uncomment if you want to see the request
    var slotValue;

    //if we have a slot, get the text and store it into speechOutput
    if (slot && slot.value) {
        //we have a value in the slot
        slotValue = slot.value.toLowerCase();
        return slotValue;
    } else {
        //we didn't get a value in the slot.
        return false;
    }
}

/*
 * Logger using Template Literals.
 * See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals.
 */
function log(title, msg) {
    console.log(`[${title}] ${msg}`);
}

/*
 * Debug - inspect and log object content.
 *
 */
function inspectLogObj(obj, depth = null) {
    const util = require('util');
    console.log(util.inspect(obj, {depth: depth}));
}

/*
 * Checks if a file is a jpeg image.
 * https://stackoverflow.com/questions/8473703/in-node-js-given-a-url-how-do-i-check-whether-its-a-jpg-png-gif/8475542#8475542
 */
function isJpg(file) {
    const jpgMagicNum = 'ffd8ffe0';
    var magicNumInFile = file.toString('hex',0,4);
    //console.log("magicNumInFile: " + magicNumInFile);
  
    if (magicNumInFile === jpgMagicNum) {
        return true;
    } else {
        return false;
    }
}