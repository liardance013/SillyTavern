const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;
const sanitize = require('sanitize-filename');
const { getConfigValue } = require('./util');
const contentDirectory = path.join(process.cwd(), 'default/content');
const contentLogPath = path.join(contentDirectory, 'content.log');
const contentIndexPath = path.join(contentDirectory, 'index.json');

function checkForNewContent() {
    try {
        if (getConfigValue('skipContentCheck', false)) {
            return;
        }

        const contentLog = getContentLog();
        const contentIndexText = fs.readFileSync(contentIndexPath, 'utf8');
        const contentIndex = JSON.parse(contentIndexText);

        for (const contentItem of contentIndex) {
            // If the content item is already in the log, skip it
            if (contentLog.includes(contentItem.filename)) {
                continue;
            }

            contentLog.push(contentItem.filename);
            const contentPath = path.join(contentDirectory, contentItem.filename);

            if (!fs.existsSync(contentPath)) {
                console.log(`Content file ${contentItem.filename} is missing`);
                continue;
            }

            const contentTarget = getTargetByType(contentItem.type);

            if (!contentTarget) {
                console.log(`Content file ${contentItem.filename} has unknown type ${contentItem.type}`);
                continue;
            }

            const targetPath = path.join(process.cwd(), contentTarget, contentItem.filename);

            if (fs.existsSync(targetPath)) {
                console.log(`Content file ${contentItem.filename} already exists in ${contentTarget}`);
                continue;
            }

            fs.cpSync(contentPath, targetPath, { recursive: true, force: false });
            console.log(`Content file ${contentItem.filename} copied to ${contentTarget}`);
        }

        fs.writeFileSync(contentLogPath, contentLog.join('\n'));
    } catch (err) {
        console.log('Content check failed', err);
    }
}

function getTargetByType(type) {
    switch (type) {
        case 'character':
            return 'public/characters';
        case 'sprites':
            return 'public/characters';
        case 'background':
            return 'public/backgrounds';
        case 'world':
            return 'public/worlds';
        case 'sound':
            return 'public/sounds';
        case 'avatar':
            return 'public/User Avatars';
        case 'theme':
            return 'public/themes';
        case 'workflow':
            return 'public/user/workflows';
        default:
            return null;
    }
}

function getContentLog() {
    if (!fs.existsSync(contentLogPath)) {
        return [];
    }

    const contentLogText = fs.readFileSync(contentLogPath, 'utf8');
    return contentLogText.split('\n');
}

async function downloadChubLorebook(id) {
    const result = await fetch('https://api.chub.ai/api/lorebooks/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            'fullPath': id,
            'format': 'SILLYTAVERN',
        }),
    });

    if (!result.ok) {
        const text = await result.text();
        console.log('Chub returned error', result.statusText, text);
        throw new Error('Failed to download lorebook');
    }

    const name = id.split('/').pop();
    const buffer = await result.buffer();
    const fileName = `${sanitize(name)}.json`;
    const fileType = result.headers.get('content-type');

    return { buffer, fileName, fileType };
}

async function downloadChubCharacter(id) {
    const result = await fetch('https://api.chub.ai/api/characters/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            'format': 'tavern',
            'fullPath': id,
        })
    });

    if (!result.ok) {
        const text = await result.text();
        console.log('Chub returned error', result.statusText, text);
        throw new Error('Failed to download character');
    }

    const buffer = await result.buffer();
    const fileName = result.headers.get('content-disposition')?.split('filename=')[1] || `${sanitize(id)}.png`;
    const fileType = result.headers.get('content-type');

    return { buffer, fileName, fileType };
}

/**
 *
 * @param {String} str
 * @returns { { id: string, type: "character" | "lorebook" } | null }
 */
function parseChubUrl(str) {
    const splitStr = str.split('/');
    const length = splitStr.length;

    if (length < 2) {
        return null;
    }

    let domainIndex = -1;

    splitStr.forEach((part, index) => {
        if (part === 'www.chub.ai' || part === 'chub.ai') {
            domainIndex = index;
        }
    });

    const lastTwo = domainIndex !== -1 ? splitStr.slice(domainIndex + 1) : splitStr;

    const firstPart = lastTwo[0].toLowerCase();

    if (firstPart === 'characters' || firstPart === 'lorebooks') {
        const type = firstPart === 'characters' ? 'character' : 'lorebook';
        const id = type === 'character' ? lastTwo.slice(1).join('/') : lastTwo.join('/');
        return {
            id: id,
            type: type
        };
    } else if (length === 2) {
        return {
            id: lastTwo.join('/'),
            type: 'character'
        };
    }

    return null;
}

// Warning: Some characters might not exist in JannyAI.me
async function downloadJannyCharacter(uuid) {
    // This endpoint is being guarded behind Bot Fight Mode of Cloudflare
    // So hosted ST on Azure/AWS/GCP/Collab might get blocked by IP
    // Should work normally on self-host PC/Android
    const result = await fetch('https://api.janitorai.me/api/v1/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({
            'characterId': uuid,
        })
    });

    if (result.ok) {
        const downloadResult = await result.json();
        if (downloadResult.status === 'ok') {
            const imageResult = await fetch(downloadResult.downloadUrl);
            const buffer = await imageResult.buffer();
            const fileName = `${sanitize(uuid)}.png`;
            const fileType = result.headers.get('content-type');
    
            return { buffer, fileName, fileType };
        }  
    }

    console.log('Janny returned error', result.statusText, await result.text());
    throw new Error('Failed to download character');
}

/**
* @param {String} url
* @returns {String | null } UUID of the character
*/
function parseJannyUrl(url) {
   // Extract UUID from URL
    const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/;
    const matches = url.match(uuidRegex);

    // Check if UUID is found
    const uuid = matches ? matches[0] : null;
    return uuid;
}

/**
 * Registers endpoints for custom content management
 * @param {import('express').Express} app Express app
 * @param {any} jsonParser JSON parser middleware
 */
function registerEndpoints(app, jsonParser) {
    app.post('/api/content/import', jsonParser, async (request, response) => {
        if (!request.body.url) {
            return response.sendStatus(400);
        }

        try {
            const url = request.body.url;
            let result;
            let type;

            const isJannnyContent = url.includes('janitorai');
            if (isJannnyContent) {
                const uuid = parseJannyUrl(url);
                if (!uuid) {
                    return response.sendStatus(404);
                }

                type = 'character';
                result = await downloadJannyCharacter(uuid);
            } else {
                const chubParsed = parseChubUrl(url);
                type = chubParsed?.type;

                if (chubParsed?.type === 'character') {
                    console.log('Downloading chub character:', chubParsed.id);
                    result = await downloadChubCharacter(chubParsed.id);
                }
                else if (chubParsed?.type === 'lorebook') {
                    console.log('Downloading chub lorebook:', chubParsed.id);
                    result = await downloadChubLorebook(chubParsed.id);
                }
                else {
                    return response.sendStatus(404);
                }
            }
            
            if (result.fileType) response.set('Content-Type', result.fileType);
            response.set('Content-Disposition', `attachment; filename="${result.fileName}"`);
            response.set('X-Custom-Content-Type', type);
            return response.send(result.buffer);
        } catch (error) {
            console.log('Importing custom content failed', error);
            return response.sendStatus(500);
        }
    });
}

module.exports = {
    checkForNewContent,
    registerEndpoints,
};
