'use strict';

// --- 1. IMPORT LIBRARIES ---
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Always load .env that sits next to this file, regardless of where node is started
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(bodyParser.json());
const port = process.env.PORT || 3000;

// --- 2. SUPABASE CLIENT SETUP ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const conversationsTable = process.env.SUPABASE_CONVERSATIONS_TABLE || 'support_conversations';
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase client initialised');
} else {
    console.warn('⚠️  Supabase credentials are missing. Conversation logging will be skipped.');
}

let geminiClient = null;
if (geminiApiKey) {
    geminiClient = new GoogleGenerativeAI(geminiApiKey);
    console.log('✅ Gemini client initialised');
} else {
    console.warn('⚠️  Gemini API key missing; fallback will use default message.');
}

async function generateFallbackResponse(prompt) {
    if (!geminiClient) {
        console.warn('⚠️  Gemini client not available; using default fallback message.');
        return "I'm sorry, I didn't catch that. Could you please rephrase?";
    }

    try {
        const model = geminiClient.getGenerativeModel({ model: geminiModel });
        const result = await model.generateContent(prompt);
        const candidateText = result?.response?.text()?.trim();
        return candidateText || "I'm sorry, I still didn't understand. Could you please clarify?";
    } catch (error) {
        console.error('❌ Gemini fallback failed:', error.message);
        return "I'm sorry, I didn't catch that. Could you please rephrase?";
    }
}

// --- 3. HELPER FUNCTIONS ---
const CHIP_IMAGES = {
    support: 'https://www.svgrepo.com/show/485554/customer-support.svg',
    sadqah: 'https://saylaniwelfareusa.com/images/cloudinaryImages/donate-animal-main.webp',
    oldAgeHome: 'https://saylaniwelfareusa.com/images/oldAgeHome/homeV2.svg'
};

function normalizeString(value) {
    if (!value) return null;
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'object') {
        if (value.name) return String(value.name).trim();
        if (value.original) return String(value.original).trim();
        if (value.displayName) return String(value.displayName).trim();
    }
    return null;
}

function extractName(parameters) {
    if (!parameters) return null;
    return normalizeString(
        parameters.name ||
        parameters.person ||
        (parameters.person && parameters.person.name) ||
        (parameters.person && parameters.person.original) ||
        parameters['given-name']
    );
}

function extractEmail(parameters) {
    if (!parameters) return null;
    const email = parameters.email || parameters.emailAddress || parameters['email-address'];
    return normalizeString(email);
}

function extractUserMessage(parameters, fallbackText) {
    if (!parameters) return normalizeString(fallbackText);
    return normalizeString(
        parameters.problem ||
        parameters.issue ||
        parameters.message ||
        parameters['problem-description'] ||
        parameters['customer_message'] ||
        fallbackText
    );
}

async function saveConversationRecord(record) {
    if (!supabase) {
        console.warn('⏭️  Skipping Supabase insert because client is not initialised.');
        return;
    }

    const sanitizedRecord = Object.entries(record).reduce((acc, [key, value]) => {
        acc[key] = value || null;
        return acc;
    }, {});

    const { data, error } = await supabase.from(conversationsTable).insert([sanitizedRecord]).select();
    if (error) {
        console.error('❌ Failed to store conversation in Supabase:', error.message);
    } else {
        console.log('💾 Conversation stored in Supabase', data?.[0]?.id || '');
    }
}

function buildChipsPayload(options) {
    return {
        "payload": {
            "richContent": [
                [{
                    "type": "chips",
                    "options": options
                }]
            ]
        }
    };
}

function buildMissingFieldsResponse(missing) {
    const text = `I still need your ${missing.join(' and ')}. Please provide the remaining detail(s) so I can log your request.`;
    return {
        "fulfillmentMessages": [{
            "text": { "text": [text] }
        }]
    };
}

// --- 4. WEBHOOK ROUTE ---
app.post('/dialogflow', async (request, response) => {
    try {
        console.log('👉 Request received!');

        const detectedIntent = request.body.queryResult.intent.displayName;
        const parameters = request.body.queryResult.parameters || {};
        const sessionId = request.body.session || request.body.sessionId || request.body.responseId;
        const channel = request.body.originalDetectIntentRequest?.source || 'dialogflow';
        const queryText = request.body.queryResult.queryText || '';

        // Map chip labels (or quick replies) to server-side intents
        const chipIntentMap = {
            'customer support': 'Customer Support',
            'customer support help': 'Customer Support'
        };

        let intentName = detectedIntent;
        const normalizedQuery = queryText.trim().toLowerCase();
        if (chipIntentMap[normalizedQuery]) {
            intentName = chipIntentMap[normalizedQuery];
            console.log(`🔁 Overriding intent based on chip selection: ${intentName}`);
        }

        if (intentName === 'Default Welcome Intent') {
            console.log('✅ Manual Logic: Welcome Intent');

            const jsonResponse = {
                "fulfillmentMessages": [
                    {
                        "text": {
                            "text": [
                                "Welcome to Our Virtual Assistant. How can I help you today?"
                            ]
                        }
                    },
                    {
                        "text": {
                            "text": [
                                "Please select a category below to continue:"
                            ]
                        }
                    },
                    buildChipsPayload([{
                        "text": "Customer Support",
                        "image": { "src": { "rawUrl": CHIP_IMAGES.support } }
                    }])
                ]
            };
            return response.json(jsonResponse);
        } else if (intentName === 'Customer Support') {
            console.log('✅ Customer Support intent triggered');
            const userName = normalizeString(parameters.name);
            const userEmail = normalizeString(parameters.email);
            const userMessage = normalizeString(parameters.message || queryText);

            const missingFields = [];
            if (!userName) missingFields.push('name');
            if (!userEmail) missingFields.push('email');
            if (!userMessage) missingFields.push('message');

            if (missingFields.length > 0) {
                return response.json(buildMissingFieldsResponse(missingFields));
            }

            await saveConversationRecord({
                session_id: sessionId,
                intent_name: intentName,
                user_name: userName,
                user_email: userEmail,
                user_message: userMessage,
                channel
            });

            return response.json({
                "fulfillmentMessages": [{
                        "text": {
                            "text": [
                                `Thanks ${userName}! I have logged your request and our team will reach out at ${userEmail} very soon.`
                            ]
                        }
                }
                ]
            });
        } else {
            console.log('⚙️  Fallback handler hit');
            const fallbackText = await generateFallbackResponse(queryText || 'Hello');
            return response.json({
                "fulfillmentText": fallbackText
            });
        }
    } catch (error) {
        console.error('❌ Error handling Dialogflow request:', error);
        return response.json({
            "fulfillmentText": "Something went wrong while processing your request. Please try again."
        });
    }
});

app.listen(port, () => {
    console.log(`Saylani Bot is running locally on port ${port}`);
});
