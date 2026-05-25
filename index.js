/*
 * DynamicExpressions v4.2 — Absolute Visual Novel Sprite Lock
 * Fixes: Unyielding Shield against ST core clearing sprites on user message.
 */

(function() {
    const MODULE_NAME = 'dynamic-expressions';
    
    let scriptModule;
    let extension_settings;

    let settings = null;
    const DEFAULTS = {
        enabled: false,
        source: 'internal_flux', 
        selectedPresetId: '',
        negativePrompt: 'different person, new face, identity change, multiple people, extra characters, scenery, complex background, text, watermark',
        spriteType: 'upper_body',
        skipNonCharacters: true,
        // When false (default): characters that already have a hand-made sprite
        // pack are left to SillyTavern's native Expressions module — no generation,
        // no conflict. When true: DynamicExpressions generates and overrides even
        // for those characters.
        overrideExistingSprites: false
    };

    let isGenerating = false;
    const activeSpritesBase64 = {}; 

    const BLANK_PNG = (function(){
        try {
            const c = document.createElement('canvas'); c.width = 512; c.height = 512;
            const x = c.getContext('2d'); x.fillStyle = '#000000'; x.fillRect(0, 0, 512, 512);
            let d = c.toDataURL('image/png'); return d.indexOf(',') >= 0 ? d.split(',')[1] : d;
        } catch(e) { return 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADklEQVQI12NgGAWDEwAAAZAAASlMlecAAAAASUVORK5CYII='; }
    })();

    // ══════════════════════════════════════
    // BOOTSTRAP & EVENTS
    // ══════════════════════════════════════

    jQuery(async () => {
        const modulesLoaded = await loadModules();
        if (!modulesLoaded) return;

        if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
        settings = Object.assign({}, DEFAULTS, extension_settings[MODULE_NAME]);

        setTimeout(addSettingsPanel, 500);
        
        if (scriptModule.eventSource && scriptModule.event_types) {
            
            scriptModule.eventSource.on(scriptModule.event_types.MESSAGE_RECEIVED, (messageId) => {
    if (!settings.enabled) return;
    
    // Ignore messages while AutoBackground is generating in silent mode
    if (window._autoBgSilentGenerating) {
        console.log('[DynamicExpressions] Skipping message — AutoBackground silent generation in progress.');
        return;
    }
    
    const chatArray = scriptModule.chat || [];
    const msg = chatArray[messageId];
    
    if (msg && (msg.is_user || msg.is_system)) {
        setTimeout(forceRestoreAllSprites, 10);
        return;
    }

    // Ignore BG-only messages from AutoBackground (silent mode)
    // Use the same criterion AutoBackground uses to mark/remove them
    const looksLikeBgMsg = msg && (
        (msg.extra && (msg.extra.image || msg.extra.inline_image)) ||
        (msg.mes && msg.mes.includes('<img'))
    );
    if (looksLikeBgMsg) {
        console.log('[DynamicExpressions] Skipping BG-only message, ignoring.');
        return;
    }
    
    handleMessage(messageId, false);
});
            
            scriptModule.eventSource.on(scriptModule.event_types.MESSAGE_SWIPED, (messageId) => handleMessage(messageId, false));
            
            scriptModule.eventSource.on(scriptModule.event_types.CHAT_CHANGED, () => {
                Object.keys(activeSpritesBase64).forEach(k => delete activeSpritesBase64[k]);
                Object.keys(characterTypeCache).forEach(k => delete characterTypeCache[k]);
                $('#visual-novel-wrapper .expression-holder[data-de-clone]').remove();
                setTimeout(restoreSavedSpriteFromStorage, 500); 
            });
        }

        initSpriteShield(); 
        setTimeout(restoreSavedSpriteFromStorage, 1500);

        // Re-spread sprites when the window/layout changes size.
        $(window).on('resize.dynamicExpressions', () => {
            clearTimeout(window._deLayoutTimer);
            window._deLayoutTimer = setTimeout(layoutGroupSprites, 100);
        });
    });

    // Forcibly restores ALL sprites (for both group and solo modes)
    function forceRestoreAllSprites() {
        const isGroup = !!scriptModule.selected_group;
        Object.entries(activeSpritesBase64).forEach(([avatarName, b64]) => {
            if (b64) updateUIWithSprite(b64, avatarName, true, isGroup); 
        });
        // Re-spread after all sprites are back in the DOM.
        scheduleLayout();
    }

    function restoreSavedSpriteFromStorage() {
        if (scriptModule.this_chid === undefined) return;
        const char = scriptModule.characters[scriptModule.this_chid];
        if (!char) return;
        const charAvatarName = char.avatar || "default";
        try {
            const savedB64 = localStorage.getItem(`de_sprite_${charAvatarName}`);
            if (savedB64 && savedB64.length > 100) {
                activeSpritesBase64[charAvatarName] = savedB64;
                const isGroup = !!scriptModule.selected_group;
                updateUIWithSprite(savedB64, charAvatarName, true, isGroup);
            }
        } catch (e) {
            console.error("[DynamicExpressions] Error reading LocalStorage:", e);
            localStorage.removeItem(`de_sprite_${charAvatarName}`);
        }
    }

    // ══════════════════════════════════════
    // ABSOLUTE SHIELD PROTECTION
    // ══════════════════════════════════════

    function initSpriteShield() {
        const shieldObserver = new MutationObserver((mutations) => {
            if (Object.keys(activeSpritesBase64).length === 0) return;

            for (const mutation of mutations) {
                
                // 1. PROTECTION AGAINST DOM ELEMENT REMOVAL
                if (mutation.type === 'childList') {
                    for (const node of mutation.removedNodes) {
                        if (node.nodeType !== 1) continue; 
                        const $node = $(node);
                        
                        if ($node.hasClass('expression-holder')) {
                            const avatarName = $node.attr('data-avatar');
                            if (avatarName && activeSpritesBase64[avatarName]) {
                                const $target = $('#visual-novel-wrapper').is(':visible') ? $('#visual-novel-wrapper') : $('#expression-wrapper');
                                $target.append($node); 
                                $node.removeClass('hidden').show();
                                const $img = $node.find('img').first();
                                $img.attr('src', `data:image/png;base64,${activeSpritesBase64[avatarName]}`).css({ opacity: 1 }).show();
                                // A holder was restored — re-spread the group.
                                if ($('#visual-novel-wrapper').is(':visible')) {
                                    clearTimeout(window._deLayoutTimer);
                                    window._deLayoutTimer = setTimeout(layoutGroupSprites, 30);
                                }
                            }
                        }
                    }
                }

                // 2. ATTRIBUTE PROTECTION
                if (mutation.type === 'attributes') {
                    const el = mutation.target;
                    const $el = $(el);

                    // 2a. Hard SRC protection (no de-updating flags, pure logic)
                    if (mutation.attributeName === 'src' && $el.hasClass('expression')) {
                        let avatarName = $el.closest('.expression-holder').attr('data-avatar');
                        if (!avatarName && $el.is('#expression-image') && scriptModule.this_chid !== undefined) {
                            avatarName = scriptModule.characters[scriptModule.this_chid]?.avatar;
                        }

                        if (avatarName && activeSpritesBase64[avatarName]) {
                            const targetSrc = `data:image/png;base64,${activeSpritesBase64[avatarName]}`;
                            const currentSrc = $el.attr('src') || '';
                            
                            // If ST cleared src or substituted the default avatar — instantly revert
                            if (currentSrc !== targetSrc) {
                                $el.attr('src', targetSrc).css({ opacity: 1 }).removeClass('default hidden defaultHidden expression-hidden').show();
                            }
                        }
                    }

                    // 2b. Visibility protection (removal of hidden class and display:none)
                    if (mutation.attributeName === 'class' || mutation.attributeName === 'style') {
                        const isHidden = $el.hasClass('hidden') || $el.css('display') === 'none';
                        if (!isHidden) continue;

                        let avatarName = $el.attr('data-avatar');
                        if (!avatarName && ($el.is('#expression-holder') || $el.is('#expression-image'))) {
                            if (scriptModule.this_chid !== undefined) avatarName = scriptModule.characters[scriptModule.this_chid]?.avatar;
                        }

                        if ((avatarName && activeSpritesBase64[avatarName]) || $el.is('#expression-wrapper') || $el.is('#visual-novel-wrapper')) {
                            $el.removeClass('hidden').show();
                        }
                    }
                }
            }
        });

        shieldObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'class', 'style']
        });
    }

    async function loadModules() {
        try {
            const ext = await import('../../extensions.js');
            const sc = await import('../../../script.js');
            extension_settings = ext.extension_settings; scriptModule = sc; return true;
        } catch (e1) {
            try {
                const ext = await import('../../../extensions.js');
                const sc = await import('../../../../script.js');
                extension_settings = ext.extension_settings; scriptModule = sc; return true;
            } catch (e2) { return false; }
        }
    }

    function saveSettings() {
        extension_settings[MODULE_NAME] = settings;
        if (scriptModule.saveSettingsDebounced) scriptModule.saveSettingsDebounced();
    }

    // ══════════════════════════════════════
    // SETTINGS UI
    // ══════════════════════════════════════

    function addSettingsPanel() {
        const html = `
        <div class="dynamic-expressions-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>🎭 Dynamic Sprite Expressions</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="flexGap10">
                        <label class="checkbox_label margin0">
                            <input type="checkbox" id="de-enabled"> Enable Dynamic Sprites
                        </label>
                    </div>
                    <div class="flexGap10 margintop5">
                        <label class="checkbox_label margin0" title="Automatically skips cards that are locations, objects, or abstract concepts (uses AI to detect)">
                            <input type="checkbox" id="de-skip-non-chars"> Skip non-character cards (locations, objects, etc.)
                        </label>
                    </div>
                    <div class="flexGap10 margintop5">
                        <label class="checkbox_label margin0" title="When OFF: characters that already have a hand-made sprite pack keep their existing sprites (handled by SillyTavern's native Expressions). When ON: generate dynamic sprites for them too, overriding the pack.">
                            <input type="checkbox" id="de-override-existing"> Override existing sprite packs (generate for characters that already have sprites)
                        </label>
                    </div>
                    <div class="flexGap10 margintop5" style="font-size:0.85em; color: var(--SmartThemeBodyColor, #aaa); opacity:0.8;">
                        Card type is detected once per character and cached. 
                        <span id="de-clear-cache-btn" style="cursor:pointer; text-decoration:underline; color:var(--SmartThemeQuoteColor, #5bc0de);">Clear cache</span>
                    </div>
                    <hr>
                    <div class="flexGap10 margintop5">
                        <label>Workflow Source:</label>
                        <select id="de-source" class="text_pole flex1">
                            <option value="internal_flux">Built-in: Flux 2 Klein (SwarmUI)</option>
                            <option value="autoillustrator">Custom: AutoIllustrator Preset</option>
                        </select>
                    </div>
                    <div id="de-ai-preset-wrapper" style="display:none;" class="flexGap10 margintop5">
                        <label>AI Preset:</label>
                        <select id="de-preset" class="text_pole flex1"></select>
                        <div class="menu_button fa-solid fa-rotate" id="de-refresh-presets" title="Refresh"></div>
                    </div>
                    <div class="flexGap10 margintop5">
                        <label>Sprite Format:</label>
                        <select id="de-sprite-type" class="text_pole flex1">
                            <option value="face">Face (Close-up)</option>
                            <option value="upper_body" selected>Upper Body (Portrait)</option>
                            <option value="full_body">Full Body</option>
                        </select>
                    </div>
                    <div class="margintop5">
                        <label>Negative Prompt (optional):</label>
                        <textarea id="de-neg" class="text_pole" rows="2">${settings.negativePrompt}</textarea>
                    </div>
                    <div class="flexGap10 margintop5">
                        <button class="menu_button" id="de-test-btn" style="width:100%;">🧪 Test Generation</button>
                    </div>
                </div>
            </div>
        </div>`;

        let $container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
        $container.append(html);
        
        $('#de-enabled').prop('checked', settings.enabled).on('change', function() { settings.enabled = this.checked; saveSettings(); });
        $('#de-skip-non-chars').prop('checked', settings.skipNonCharacters !== false).on('change', function() { settings.skipNonCharacters = this.checked; saveSettings(); });
        $('#de-override-existing').prop('checked', settings.overrideExistingSprites === true).on('change', function() {
            settings.overrideExistingSprites = this.checked;
            // Re-check sprite packs after this toggle changes.
            Object.keys(existingSpriteCache).forEach(k => delete existingSpriteCache[k]);
            saveSettings();
        });
        $('#de-clear-cache-btn').on('click', function() {
            Object.keys(characterTypeCache).forEach(k => delete characterTypeCache[k]);
            Object.keys(existingSpriteCache).forEach(k => delete existingSpriteCache[k]);
            toastr.info('Character type & sprite-pack cache cleared.');
        });
        $('#de-sprite-type').val(settings.spriteType).on('change', function() { settings.spriteType = this.value; saveSettings(); });
        $('#de-neg').val(settings.negativePrompt).on('input', function() { settings.negativePrompt = this.value; saveSettings(); });
        $('#de-source').val(settings.source).on('change', function() { settings.source = this.value; updateUIVisibility(); saveSettings(); });

        $('#de-refresh-presets').on('click', loadPresets);
        $('#de-test-btn').on('click', handleTestButton);
        
        loadPresets(); updateUIVisibility();
    }

    function updateUIVisibility() {
        if (settings.source === 'autoillustrator') $('#de-ai-preset-wrapper').show();
        else $('#de-ai-preset-wrapper').hide();
    }

    function getAISettings() { return (extension_settings && extension_settings.auto_illustrator) ? extension_settings.auto_illustrator : null; }

    function loadPresets() {
        const $sel = $('#de-preset').empty();
        const aiSettings = getAISettings();
        if (aiSettings && aiSettings.workflowPresets && aiSettings.workflowPresets.length) {
            aiSettings.workflowPresets.forEach(p => { $sel.append(`<option value="${p.id}">${p.name}</option>`); });
            if (settings.selectedPresetId) $sel.val(settings.selectedPresetId);
        } else {
            $sel.append('<option value="">No AutoIllustrator Presets Found</option>');
        }
        $sel.on('change', function() { settings.selectedPresetId = this.value; saveSettings(); });
    }

    // ══════════════════════════════════════
    // CHARACTER DETECTION
    // ══════════════════════════════════════

    // Cache: avatarName → true/false, so we don't query the LLM repeatedly
    const characterTypeCache = {};

    // Cache: spriteFolderName → true/false (does this char have a real sprite pack?)
    const existingSpriteCache = {};

    // Returns the name SillyTavern uses for the sprite folder of a character.
    // ST stores sprites under the character's name (or an override folder set in
    // the Expressions settings), NOT the avatar filename.
    function getSpriteFolderName(char) {
        try {
            const expr = extension_settings && extension_settings.expressions;
            const override = expr && expr.spriteFolderOverrides && (expr.spriteFolderOverrides[char.avatar] || expr.spriteFolderOverrides[char.name]);
            if (override) return override;
        } catch (e) {}
        return char.name || char.avatar || 'default';
    }

    // Checks whether the character already has a hand-made sprite pack via ST's
    // own sprites endpoint. Real sprites have a usable file path; missing labels
    // come back as placeholders (type 'failure') and must not count.
    async function hasExistingSprites(char) {
        const folder = getSpriteFolderName(char);
        if (folder in existingSpriteCache) return existingSpriteCache[folder];

        try {
            const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(folder)}`, {
                method: 'GET',
                headers: scriptModule.getRequestHeaders ? scriptModule.getRequestHeaders() : { 'Content-Type': 'application/json' },
            });
            if (!res.ok) { existingSpriteCache[folder] = false; return false; }

            const list = await res.json();
            // A real sprite has a non-empty path/files entry and is not a placeholder.
            const hasReal = Array.isArray(list) && list.some(item => {
                if (!item) return false;
                if (item.type === 'failure') return false;
                if (item.files && Array.isArray(item.files) && item.files.length) return true;
                return !!item.path;
            });

            console.log(`[DynamicExpressions] Sprite pack check for "${folder}": ${hasReal ? 'HAS sprites' : 'none'}`);
            existingSpriteCache[folder] = hasReal;
            return hasReal;
        } catch (e) {
            console.warn('[DynamicExpressions] Sprite pack check failed, assuming NO sprites:', e);
            existingSpriteCache[folder] = false;
            return false;
        }
    }

    async function isCharacterCard(char) {
        const avatarKey = char.avatar || char.name || 'unknown';

        if (avatarKey in characterTypeCache) {
            return characterTypeCache[avatarKey];
        }

        if (!scriptModule.generateQuietPrompt) {
            characterTypeCache[avatarKey] = true;
            return true;
        }

        const desc = (char.description || char.personality || '').substring(0, 2000);
        const name = char.name || '';

        const prompt = `[OOC: You are a classifier. Determine if the following character card describes an entity that CAN have a visual sprite (a living being, humanoid, robot, android, AI with a body, anthropomorphic creature, sentient substance with a physical form, or any entity that can visually express emotions and poses). Do NOT classify as CHARACTER: locations, buildings, abstract concepts, weather systems, inanimate objects, settings, or world-lore entries.

Character name: ${name}
Character description:
${desc}

Reply with ONLY one word: CHARACTER or LOCATION]`;

        try {
            const res = await scriptModule.generateQuietPrompt(prompt, false, true);
            const answer = (res || '').trim().toUpperCase();
            const isChar = answer.startsWith('CHARACTER');
            console.log(`[DynamicExpressions] Card type check for "${name}": ${answer} → ${isChar ? 'will generate' : 'SKIPPED'}`);
            characterTypeCache[avatarKey] = isChar;
            return isChar;
        } catch (e) {
            console.warn('[DynamicExpressions] Card type check failed, assuming CHARACTER:', e);
            characterTypeCache[avatarKey] = true;
            return true;
        }
    }

    // ══════════════════════════════════════
    // MAIN LOGIC
    // ══════════════════════════════════════

    async function handleTestButton() {
        if (isGenerating) { toastr.warning("Generation in progress..."); return; }
        
        const currentChId = scriptModule.this_chid;
        const characters = scriptModule.characters;
        const isGroup = !!scriptModule.selected_group;
        
        if (!isGroup && (currentChId === undefined || !characters || !characters[currentChId])) {
            toastr.error("Select a character or group chat first!");
            return;
        }

        toastr.info("Starting dynamic sprite generation test...");
        const chatArray = scriptModule.chat || [];
        let testMsgId = -1;
        for (let i = chatArray.length - 1; i >= 0; i--) {
            if (!chatArray[i].is_user && !chatArray[i].is_system) { testMsgId = i; break; }
        }
        await handleMessage(testMsgId, true);
    }

    async function handleMessage(messageId, isTest = false) {
        if (!settings.enabled && !isTest) return;
        if (isGenerating) return;

        try {
            const currentChId = scriptModule.this_chid;
            const characters = scriptModule.characters;
            const chatArray = scriptModule.chat;
            const isGroup = !!scriptModule.selected_group;

            let targetCharId = currentChId;
            const msg = messageId >= 0 ? chatArray[messageId] : null;
            
            if (msg && !msg.is_user && !msg.is_system) {
                let found = false;
                if (msg.force_avatar) {
                    for (let i = 0; i < characters.length; i++) {
                        if (characters[i].avatar === msg.force_avatar) { targetCharId = i; found = true; break; }
                    }
                }
                if (!found && msg.name) {
                    for (let i = 0; i < characters.length; i++) {
                        if (characters[i].name === msg.name) { targetCharId = i; found = true; break; }
                    }
                }
            }

            if (targetCharId === undefined && !isGroup) targetCharId = currentChId;
            if (targetCharId === undefined || !characters || !characters[targetCharId]) return;

            const char = characters[targetCharId];
            const charName = char.name || "Character";
            const charDesc = char.description || char.personality || "No specific description.";
            const charAvatarName = char.avatar || "default";
            let textToAnalyze = "Smiling, looking at viewer, standard pose.";
            if (msg && msg.mes) textToAnalyze = msg.mes;

            // Check whether this card is an actual character (not a location/object)
            if (settings.skipNonCharacters && !isTest) {
                const isChar = await isCharacterCard(char);
                if (!isChar) {
                    console.log(`[DynamicExpressions] Skipping "${charName}" — not a character card (location/object/concept).`);
                    return;
                }
            }

            // If the character already has a hand-made sprite pack and the user
            // hasn't opted to override, leave it to ST's native Expressions module.
            // This removes the generate-vs-native race for those characters.
            // (Test button always generates, so the user can preview.)
            if (!settings.overrideExistingSprites && !isTest) {
                const hasSprites = await hasExistingSprites(char);
                if (hasSprites) {
                    console.log(`[DynamicExpressions] Skipping "${charName}" — already has a sprite pack (override disabled).`);
                    return;
                }
            }

            console.log(`[DynamicExpressions] Analyzing message for ${charName}...`);
            isGenerating = true;
            showLoadingSpinner(charAvatarName);

            const spriteTags = await generateSpritePrompt(textToAnalyze, charName, charDesc);

            let avatarB64 = BLANK_PNG;
            if (char.avatar) {
                try {
                    const urls = [`/characters/${encodeURIComponent(char.avatar)}`, `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}`];
                    for (let url of urls) {
                        const r = await fetch(url);
                        if (r.ok) { const blob = await r.blob(); if (blob.size > 100) { avatarB64 = await blobToBase64(blob); break; } }
                    }
                } catch(e) {}
            }

            const imageB64 = await executeGeneration(spriteTags, avatarB64, charName);
            
            if (imageB64) {
                try { 
                    localStorage.setItem(`de_sprite_${charAvatarName}`, imageB64); 
                } catch (e) {
                    Object.keys(localStorage).forEach(key => { if (key.startsWith('de_sprite_') && key !== `de_sprite_${charAvatarName}`) localStorage.removeItem(key); });
                    try { localStorage.setItem(`de_sprite_${charAvatarName}`, imageB64); } catch (e2) {}
                }
                
                updateUIWithSprite(imageB64, charAvatarName, false, isGroup); 
                if (isTest) toastr.success(`Sprite for ${charName} generated successfully!`);
            } else {
                throw new Error("ComfyUI returned empty result.");
            }

        } catch (err) {
            console.error('[DynamicExpressions] Error:', err);
            toastr.error(err.message);
        } finally {
            isGenerating = false;
            hideLoadingSpinner();
        }
    }

    async function generateSpritePrompt(text, charName, charDesc) {
        if (!scriptModule.generateQuietPrompt) return "Keep the person's face, hair and identity from the reference image exactly the same. Place them on a simple white background.";
        let formatTag = settings.spriteType === 'face' ? "Crop to a close-up portrait of the face." : settings.spriteType === 'full_body' ? "Show the full body from head to feet in a standing pose." : "Show an upper-body portrait from the chest up.";
        // EDIT-STYLE PROMPT: Flux 2 Klein is an edit model — it expects instructions
        // ("change X", "make her smile", "keep her face the same"), NOT scene descriptions.
        // Descriptive tag lists make Klein hallucinate a new identity over the reference.
        const systemPrompt = `[OOC: You are writing an EDIT INSTRUCTION for the Flux 2 Klein image-edit model. The reference image is the character's avatar. Your job is to describe ONLY what should CHANGE on that avatar to reflect the character's current state in this scene — NOT to redescribe the character.

Character Name: ${charName}
Character description (for context only — do NOT redescribe these traits, the reference image already has them): ${charDesc.substring(0, 1500)}
Last in-story message: "${text}"

Write 3 to 6 short imperative sentences in plain English. Use verbs like "Change", "Make", "Add", "Remove", "Set". Cover only what is relevant to the current moment:
- Facial expression and emotion (e.g. "Make her expression a soft smile with relaxed eyes.")
- Body pose and posture (e.g. "Change the pose to arms crossed, leaning slightly forward.")
- Clothing, if it has changed or is notable in the scene (e.g. "Change the outfit to a black hoodie and jeans.")
- Hairstyle, only if it has changed (e.g. "Tie the hair back into a ponytail.")

ALWAYS end with this exact sentence: "Keep her face, hair color, hair length, eye color and identity exactly the same as the reference image. Background: plain white. ${formatTag}"

Output ONLY the instructions, no preamble, no tags, no quotes, no markdown.]`;
        try {
            let res = await scriptModule.generateQuietPrompt(systemPrompt, false, true);
            return res.trim().replace(/^["']|["']$/g, '');
        } catch (e) { return `Keep the person's face, hair and identity from the reference image exactly the same. Place them on a plain white background. ${formatTag}`; }
    }

    // ══════════════════════════════════════
    // COMFYUI ENGINE
    // ══════════════════════════════════════

    function getComfyUrl() {
        const ai = getAISettings();
        if (ai && ai.comfyUrl) return ai.comfyUrl.replace(/\/+$/, '');
        return (extension_settings.sd && extension_settings.sd.comfy_url) ? extension_settings.sd.comfy_url.replace(/\/+$/, '') : 'http://127.0.0.1:8188';
    }

    async function comfyUploadImage(b64, filename) {
        const base = getComfyUrl();
        const blob = b64ToBlob(b64, 'image/png');
        const fd = new FormData(); fd.append('image', blob, filename); fd.append('overwrite', 'true');
        const r = await fetch(base + '/upload/image', { method: 'POST', body: fd });
        if (!r.ok) throw new Error('ComfyUI upload failed: ' + r.status);
        return (await r.json()).name || filename;
    }

    function escapeJSON(s) { return s ? s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') : ''; }

    function buildInternalFluxWorkflow(avatarB64, dynamicPrompt, seed) {
        return {
            "4": { "inputs": { "unet_name": "Flux2\\flux-2-klein-4b-fp8.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader" },
            "5": { "inputs": { "width": ["107", 0], "height": ["107", 1], "batch_size": 1 }, "class_type": "EmptyFlux2LatentImage" },
            "6": { "inputs": { "text": dynamicPrompt + ' Keep the person from the reference image. Do not change the identity. Plain white background.', "clip": ["100", 0] }, "class_type": "CLIPTextEncode" },
            "7": { "inputs": { "text": settings.negativePrompt || "different person, new face, identity change, multiple people, scenery, background details", "clip": ["100", 0] }, "class_type": "CLIPTextEncode" },
            "8": { "inputs": { "samples": ["10", 0], "vae": ["101", 0] }, "class_type": "VAEDecode" },
            "10": { "inputs": { "noise_seed": seed, "steps": 8, "cfg": 1, "sampler_name": "euler", "scheduler": "flux2", "start_at_step": 0, "end_at_step": 10000, "var_seed": 0, "var_seed_strength": 0, "sigma_max": -1, "sigma_min": -1, "rho": 7, "add_noise": "enable", "return_with_leftover_noise": "disable", "previews": "default", "tile_sample": false, "tile_size": 1024, "model": ["4", 0], "positive": ["104", 0], "negative": ["7", 0], "latent_image": ["5", 0] }, "class_type": "SwarmKSampler" },
            "100": { "inputs": { "clip_name": "qwen_3_4b.safetensors", "type": "flux2", "device": "default" }, "class_type": "CLIPLoader" },
            "101": { "inputs": { "vae_name": "Flux\\flux2-vae.safetensors" }, "class_type": "VAELoader" },
            "102": { "inputs": { "image_base64": avatarB64 }, "class_type": "SwarmLoadImageB64" },
            "103": { "inputs": { "pixels": ["102", 0], "vae": ["101", 0] }, "class_type": "VAEEncode" },
            "104": { "inputs": { "conditioning": ["6", 0], "latent": ["103", 0] }, "class_type": "ReferenceLatent" },
            "105": { "inputs": { "filename_prefix": "DynamicSprite", "images": ["108", 0] }, "class_type": "SaveImage" },
            "106": { "inputs": { "upscale_method": "lanczos", "megapixels": 1, "resolution_steps": 1, "image": ["102", 0] }, "class_type": "ImageScaleToTotalPixels" },
            "107": { "inputs": { "image": ["106", 0] }, "class_type": "GetImageSize" },
            "108": { "inputs": { "images": ["8", 0] }, "class_type": "SwarmRemBg" }
        };
    }

    async function executeGeneration(prompt, avatarB64, charName) {
        let workflowObj;
        if (settings.source === 'internal_flux') {
            workflowObj = buildInternalFluxWorkflow(avatarB64, prompt, Math.floor(Math.random() * 999999999));
        } else {
            const aiSettings = getAISettings();
            if (!aiSettings) throw new Error("AutoIllustrator extension is missing.");
            const preset = aiSettings.workflowPresets?.find(p => p.id === settings.selectedPresetId);
            if (!preset || !preset.workflow) throw new Error("Select a valid AutoIllustrator Preset!");
            let uploadedInputName = 'de_empty.png';
            try { uploadedInputName = await comfyUploadImage(avatarB64, `de_avatar_${charName.replace(/[^a-zA-Z0-9]/g, '_')}.png`); } catch(e) {}

            let wfStr = preset.workflow;
            const sdSettings = extension_settings.sd || {};
            const strReplacements = { '%prompt%': escapeJSON(prompt), '%negative_prompt%': escapeJSON(settings.negativePrompt), '%input_image_name%': escapeJSON(uploadedInputName), '%char_avatar%': avatarB64, '%input_image%': avatarB64, '%user_avatar%': BLANK_PNG, '%avatar_1%': avatarB64, '%model%': escapeJSON(preset.model || sdSettings.model || ''), '%vae%': escapeJSON(preset.vae || sdSettings.vae || ''), '%sampler%': escapeJSON(preset.sampler || 'euler'), '%scheduler%': escapeJSON(preset.scheduler || 'normal') };
            for (let i = 2; i <= 8; i++) strReplacements[`%avatar_${i}%`] = BLANK_PNG;
            for (let key in strReplacements) wfStr = wfStr.split(key).join(strReplacements[key]);
            const numReplacements = { '%width%': preset.width || 512, '%height%': preset.height || 768, '%seed%': Math.floor(Math.random() * 2147483647), '%steps%': preset.steps || 20, '%cfg%': preset.cfg || 7, '%scale%': preset.cfg || 7, '%denoise%': preset.denoise !== undefined ? preset.denoise : 1, '%clip_skip%': preset.clipSkip || 1 };
            for (let key in numReplacements) { const val = String(numReplacements[key]); wfStr = wfStr.split('"' + key + '"').join(val).split(key).join(val); }
            try { workflowObj = JSON.parse(wfStr); } catch (e) { throw new Error("Preset JSON Parsing Error."); }
        }

        const base = getComfyUrl();
        const qr = await fetch(base + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflowObj }) });
        if (!qr.ok) throw new Error('ComfyUI error: ' + await qr.text());
        const { prompt_id } = await qr.json();
        
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const interval = setInterval(async () => {
                attempts++;
                if (attempts > 90) { clearInterval(interval); reject(new Error("Timeout")); return; }
                try {
                    const hr = await fetch(base + '/history/' + prompt_id); if (!hr.ok) return;
                    const hist = await hr.json(); if (!hist[prompt_id]) return;
                    const entry = hist[prompt_id];
                    if (entry.status?.status_str === 'error') { clearInterval(interval); reject(new Error("ComfyUI error.")); return; }
                    const outs = entry.outputs;
                    if (outs) {
                        for (const nid in outs) {
                            const imgs = outs[nid].images;
                            if (imgs && imgs.length) {
                                const img = imgs[0];
                                const ir = await fetch(base + '/view?' + new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' }));
                                const blob = await ir.blob(); clearInterval(interval);
                                resolve(await blobToBase64(blob)); return;
                            }
                        }
                    }
                } catch (e) {}
            }, 2000);
        });
    }

    // ══════════════════════════════════════
    // UNIFIED UI INJECTION
    // ══════════════════════════════════════

    function getBaseHolderTemplate() {
        let $base = $('#expression-holder');
        if ($base.length) return $base;
        
        console.warn("[DynamicExpressions] Base expression-holder missing from DOM! Creating fallback.");
        return $(`<div class="expression-holder" style="position:absolute; bottom:0; left:50%; transform:translateX(-50%); height:100%; display:flex; align-items:flex-end;"><img class="expression" style="max-height:100%; max-width:100%; object-fit:contain;" /></div>`);
    }

    function findOrCreateHolder(charAvatarName, isGroup) {
        const $vnWrapper = $('#visual-novel-wrapper');
        
        // Look for a holder marked with our tag
        let $holder = $vnWrapper.find(`.expression-holder[data-avatar="${charAvatarName}"]`);
        if ($holder.length) return $holder;

        // If VN mode is active (solo or group), we MUST work inside the VN wrapper
        if ($vnWrapper.is(':visible')) { 
            $holder = getBaseHolderTemplate().clone();
            $holder.removeAttr('id').removeClass('hidden').attr('data-avatar', charAvatarName).attr('data-de-clone', 'true');
            $holder.find('img').first().removeAttr('id').removeClass('expression default hidden defaultHidden expression-hidden');
            $holder.find('.drag-grabber').removeAttr('id');
            // Remove hard center-lock from the cloned template so layoutGroupSprites()
            // can position each holder horizontally. Without this every clone sits at
            // left:50% / translateX(-50%) and they stack on top of each other.
            $holder.css({ left: '', right: '', transform: '' }).removeAttr('id');
            $vnWrapper.append($holder);
            return $holder;
        }

        // Standard (non-VN) mode
        $holder = getBaseHolderTemplate().first().attr('data-avatar', charAvatarName);
        if (!$('#expression-wrapper').find($holder).length) {
            $('#expression-wrapper').empty().append($holder);
        }
        return $holder;
    }

    // ══════════════════════════════════════
    // GROUP SPRITE LAYOUT (Prome-style spread)
    // ══════════════════════════════════════
    //
    // Distributes every visible DE sprite evenly across the width of the
    // visual-novel-wrapper so they never stack on top of each other.
    // Mimics SillyTavern's native VN behaviour: when the combined sprite
    // width exceeds the container, holders overlap proportionally instead
    // of clipping off-screen.
    function layoutGroupSprites() {
        const $vn = $('#visual-novel-wrapper');
        if (!$vn.is(':visible')) return;

        // Only lay out the holders we own (clones we created). Native ST holders
        // in solo mode keep their default centered position.
        const $holders = $vn.find('.expression-holder[data-de-clone="true"]').filter(function() {
            return $(this).css('display') !== 'none' && !$(this).hasClass('hidden');
        });

        const count = $holders.length;
        if (count === 0) return;

        const wrapperW = $vn.width() || $vn[0].clientWidth || window.innerWidth;

        // Single sprite → keep it centered (classic solo VN look).
        if (count === 1) {
            $holders.css({
                position: 'absolute',
                left: '50%',
                right: 'auto',
                bottom: 0,
                transform: 'translateX(-50%)',
                'z-index': 30,
            });
            // Preserve the speaking-scale transform if applicable
            applySpeakingTransform($holders);
            return;
        }

        // Multiple sprites → spread evenly. Each holder gets an equal "slot"
        // and is centered within it. Slots are allowed to be narrower than the
        // sprite (overlap) when the screen is too small, exactly like native VN.
        const slotW = wrapperW / count;

        $holders.each(function(i) {
            const $h = $(this);
            // Center of slot i, as a percentage of the wrapper width.
            const centerPct = ((i + 0.5) / count) * 100;
            $h.css({
                position: 'absolute',
                left: centerPct + '%',
                right: 'auto',
                bottom: 0,
                transform: 'translateX(-50%)',
                'max-width': (slotW * 1.15) + 'px', // small overlap allowance
                'z-index': 30,
            });
            applySpeakingTransform($h);
        });
    }

    // Re-applies the speaking pop/scale on top of the layout transform so the
    // active speaker still lifts forward without losing its horizontal position.
    function applySpeakingTransform($holder) {
        $holder.each(function() {
            const $h = $(this);
            const base = 'translateX(-50%)';
            if ($h.hasClass('de-speaking')) {
                $h.css('transform', `${base} scale(1.05) translateY(-10px)`).css('z-index', 50);
            } else {
                $h.css('transform', base);
            }
        });
    }

    // Runs layoutGroupSprites multiple times across animation frames / timers.
    // This defeats the first-render race: on the very first message the sprite
    // <img> has no decoded dimensions yet, so a single early layout call leaves
    // the holders stacked in the center. We retry on rAF, on image load, and on
    // a few staggered timers so the spread "locks in" as soon as sizes exist.
    function scheduleLayout() {
        layoutGroupSprites();
        requestAnimationFrame(() => {
            layoutGroupSprites();
            requestAnimationFrame(layoutGroupSprites);
        });
        [60, 200, 500, 900].forEach(ms => setTimeout(layoutGroupSprites, ms));
    }


    function updateUIWithSprite(b64, charAvatarName, instant = false, isGroup = false) {
        const dataUri = `data:image/png;base64,${b64}`;
        activeSpritesBase64[charAvatarName] = b64; // Update cache (the shield will now protect this image)

        const vnWrapper = $('#visual-novel-wrapper');
        const isVnMode = vnWrapper.is(':visible');

        if (!isVnMode) {
            const $wrapper = $('#expression-wrapper');
            const $holder = findOrCreateHolder(charAvatarName, isGroup);
            const $img = $holder.find('img').first();
            
            $wrapper.removeClass('hidden').show();
            $holder.removeClass('hidden').show();

            if (instant) {
                $img.attr('src', dataUri).css({ opacity: 1 }).show();
            } else {
                $img.css('opacity', 0).attr('src', dataUri).animate({ opacity: 1 }, 300);
            }
            return;
        }

        // VN MODE
        vnWrapper.find('.expression-holder').removeClass('de-speaking');

        const $holder = findOrCreateHolder(charAvatarName, isGroup);
        if (!$holder || !$holder.length) return;

        const $img = $holder.find('img').first();

        if (isGroup) {
            $holder.addClass('de-speaking');
        }

        $holder.removeClass('hidden').show();

        // When the sprite image finishes decoding it finally has real dimensions,
        // so re-run the spread then too. This is the key fix for the "stacked on
        // first appearance" bug — the early layout had nothing to measure yet.
        const imgEl = $img.get(0);
        if (imgEl) {
            imgEl.onload = () => scheduleLayout();
        }

        if (instant) {
            $img.attr('src', dataUri).css({ opacity: 1 }).show();
        } else {
            $img.css('opacity', 0).attr('src', dataUri).animate({ opacity: 1 }, 300);
        }
        
        vnWrapper.removeClass('hidden').show();

        // Spread all sprites evenly so group members never overlap.
        scheduleLayout();
    }

    function showLoadingSpinner(charAvatarName) {
        const isVnMode = $('#visual-novel-wrapper').is(':visible');
        let $target = isVnMode ? $('#visual-novel-wrapper') : $('#expression-wrapper');
        $target.removeClass('hidden').show();
        if (!$target.find('.de-spinner').length) {
            $target.append('<div class="de-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>');
        }
    }

    function hideLoadingSpinner() { $('.de-spinner').remove(); }

    function b64ToBlob(b64, type) { const raw = atob(b64); const arr = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i); return new Blob([arr], { type: type || 'image/png' }); }
    function blobToBase64(blob) { return new Promise((resolve) => { const reader = new FileReader(); reader.onloadend = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); }); }

    // ══════════════════════════════════════
    // CSS (Prome-Compatible Focus Effects)
    // ══════════════════════════════════════
    const style = document.createElement('style');
    style.innerHTML = `
        .de-spinner {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            font-size: 40px; color: #5bc0de; background: rgba(0,0,0,0.5);
            width: 80px; height: 80px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            z-index: 9999; pointer-events: none; backdrop-filter: blur(3px);
        }

        #visual-novel-wrapper .expression-holder {
            transition: transform 0.4s cubic-bezier(0.25, 1, 0.5, 1), 
                        filter 0.4s ease !important;
        }

        /* NOTE: transform is intentionally NOT set here. The horizontal spread
           position (translateX) plus the speaking pop (scale/translateY) are
           applied together inline by layoutGroupSprites()/applySpeakingTransform().
           A !important transform here would override the inline left-position
           and snap every speaking sprite back to the center, re-introducing
           the overlap bug. Only filters/z-index are handled via CSS. */
        #visual-novel-wrapper .expression-holder.de-speaking {
            filter: brightness(1.1) saturate(1.1) drop-shadow(0 0 8px rgba(255,255,255,0.4)) !important;
            z-index: 50 !important;
        }

        #visual-novel-wrapper:has(.de-speaking) .expression-holder:not(.de-speaking) {
            filter: brightness(0.7) saturate(0.8) !important;
        }
    `;
    document.head.appendChild(style);

})();
