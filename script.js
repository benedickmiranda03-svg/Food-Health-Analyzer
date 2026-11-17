/* =====================================================================
   Food Health Analyzer: object-oriented version

   Class overview
   ----------------------------------------------------------------
   Config        constants (static members)
   Util          small static helpers
   Storage       localStorage wrapper (static members)
   DietRule      one diet filter, e.g. "High protein"
   Food          nutrition data for 100 g + calculations (model)
   LogEntry      one eaten item in the daily log (model)
   FoodLog       array of LogEntry grouped by day (encapsulated)
   FoodList      saved array of Food (base class)
     FavoriteList extends FoodList
     HistoryList  extends FoodList
   Preferences   goal, diets[], allergens[], unit, theme
   PlateItem     a Food plus a portion in grams
   Plate         array of PlateItem for a photo with several foods
   Comparison    two Food objects compared nutrient by nutrient
   Channel       busy / error UI for one request type
   Analyzer      talks to the AI endpoint (service)
   App           connects everything to the page (controller / view)
   ===================================================================== */
(function(){
  'use strict';

  // ===================================================================
  // CONFIG + UTILITIES
  // ===================================================================
  class Config {
    static ENDPOINT = 'https://oxford.uk.eu.org/ai/oxford';
    static TIMEOUT_MS = 75000;
    static OZ = 28.3495;
    static DV = { protein:50, fat:78, carbs:275, fiber:28, sodium:2300, sugar:50 };
    static ALLERGENS = ['fish','shellfish','peanuts','tree nuts','dairy','eggs','gluten','soy','sesame'];
    static GRADE_SCORE = { 'A+':97, 'A':92, 'B+':84, 'B':76, 'C':60, 'D':40 };
    // [label, key, unit, which direction is better]
    static CMP_ROWS = [
      ['Calories','calories','kcal','low'], ['Protein','protein','g','high'], ['Carbs','carbs','g','low'],
      ['Fat','fat','g','low'], ['Sugar','sugar','g','low'], ['Sodium','sodium','mg','low'], ['Fiber','fiber','g','high']
    ];
    static VIEWS = ['search','photo','compare','today'];
  }

  class Util {
    static $(id){ return document.getElementById(id); }
    static esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    static fmt(n){ const r = Math.abs(n) >= 10 ? Math.round(n) : Math.round(n * 10) / 10; return String(r); }
    static clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
  }
  const $ = Util.$, esc = Util.esc, fmt = Util.fmt, clamp = Util.clamp;

  class Storage {
    static get(key, fallback){
      try { const v = localStorage.getItem('fha.' + key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    }
    static set(key, value){
      try { localStorage.setItem('fha.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    }
  }

  // ===================================================================
  // MODELS
  // ===================================================================
  class DietRule {
    constructor(id, label, test){ this.id = id; this.label = label; this.test = test; }
    check(food){ return this.test(food); }
  }
  Config.DIETS = [
    new DietRule('highprotein', 'High protein', f => f.protein >= 15),
    new DietRule('lowsodium',   'Low sodium',   f => f.sodium <= 140),
    new DietRule('lowcarb',     'Low carb',     f => f.carbs <= 15),
    new DietRule('vegetarian',  'Vegetarian',   f => f.vegetarian === true)
  ];

  class Food {
    // All nutrient values are per 100 g (sodium, vitaminC, potassium in mg).
    constructor(o = {}){
      const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
      this.name = String(o.name || 'Unknown food');
      this.category = String(o.category || 'Food');
      this.calories = num(o.calories);
      this.protein = num(o.protein);
      this.carbs = num(o.carbs);
      this.fat = num(o.fat);
      this.fiber = num(o.fiber);
      this.sugar = num(o.sugar);
      this.sodium = num(o.sodium);
      this.vitaminC = num(o.vitaminC);
      this.potassium = num(o.potassium);
      this.grade = String(o.grade || 'C');
      this.gradeLabel = String(o.gradeLabel || 'Moderate');
      this.score = clamp(Math.round(num(o.score)) || Config.GRADE_SCORE[this.grade] || 60, 0, 100);
      this.vegetarian = typeof o.vegetarian === 'boolean' ? o.vegetarian : null;
      this.allergens = Array.isArray(o.allergens) ? o.allergens.map(a => String(a).toLowerCase()) : [];
      this.swaps = (Array.isArray(o.swaps) ? o.swaps : []).slice(0, 3)
        .map(s => ({ name:String((s && s.name) || ''), grade:String((s && s.grade) || ''), note:String((s && s.note) || '') }))
        .filter(s => s.name);
      this.insight = String(o.insight || 'No insight available.');
    }

    static toneOf(grade){ return /^(A|B\+)/.test(grade) ? 'tone-good' : grade === 'B' ? 'tone-mid' : 'tone-bad'; }
    static gradeFromScore(s){ return s >= 95 ? 'A+' : s >= 88 ? 'A' : s >= 80 ? 'B+' : s >= 70 ? 'B' : s >= 50 ? 'C' : 'D'; }

    get tone(){ return Food.toneOf(this.grade); }
    get hasSwaps(){ return this.swaps.length > 0 && !/^A/.test(this.grade); }

    amount(key, grams){ return this[key] * grams / 100; }
    dailyValue(key, grams){ return Math.round(this.amount(key, grams) / Config.DV[key] * 100); }
    isSame(other){ return this.name.toLowerCase() === other.name.toLowerCase(); }
    fits(rule){ return rule.check(this); }
    flaggedAllergens(flagged){ return this.allergens.filter(a => flagged.includes(a)); }

    // Share of calories from protein / carbs / fat, as whole percents
    macroSplit(grams){
      const p = this.protein * 4 * grams / 100, c = this.carbs * 4 * grams / 100, f = this.fat * 9 * grams / 100;
      const total = p + c + f || 1;
      const pp = Math.round(p / total * 100), cp = Math.round(c / total * 100);
      return { p:pp, c:cp, f:Math.max(0, 100 - pp - cp) };
    }

    // Array of [label, 0-100] used by the score breakdown
    breakdown(){
      return [
        ['Protein',    clamp(Math.round(this.protein / 20 * 100), 0, 100)],
        ['Low sugar',  clamp(Math.round(100 - this.sugar * 6), 0, 100)],
        ['Low sodium', clamp(Math.round(100 - this.sodium / 10), 0, 100)],
        ['Fiber',      clamp(Math.round(this.fiber / 6 * 100), 0, 100)]
      ];
    }
  }

  class LogEntry {
    constructor({ name, grams, kcal, p, c, f }){
      this.name = name; this.grams = grams; this.kcal = kcal; this.p = p; this.c = c; this.f = f;
    }
    static fromFood(food, grams){
      return new LogEntry({
        name:food.name, grams:Math.round(grams), kcal:Math.round(food.amount('calories', grams)),
        p:food.amount('protein', grams), c:food.amount('carbs', grams), f:food.amount('fat', grams)
      });
    }
  }

  class FoodLog {
    #days = {};   // { 'YYYY-MM-DD': LogEntry[] }

    constructor(){
      const raw = Storage.get('log', {});
      Object.keys(raw).forEach(day => { this.#days[day] = raw[day].map(e => new LogEntry(e)); });
    }
    static dayKey(){ return new Date().toLocaleDateString('en-CA'); }

    get today(){ return this.#days[FoodLog.dayKey()] || []; }

    add(entry){
      const key = FoodLog.dayKey();
      this.#days[key] = this.today.concat([entry]);
      Object.keys(this.#days).sort().slice(0, -14).forEach(d => delete this.#days[d]); // keep 14 days
      this.#save();
    }
    removeAt(index){
      this.#days[FoodLog.dayKey()] = this.today.filter((_, i) => i !== index);
      this.#save();
    }
    clearToday(){ delete this.#days[FoodLog.dayKey()]; this.#save(); }

    totals(){
      return this.today.reduce((t, e) => ({ kcal:t.kcal + e.kcal, p:t.p + e.p, c:t.c + e.c, f:t.f + e.f }),
        { kcal:0, p:0, c:0, f:0 });
    }
    #save(){ Storage.set('log', this.#days); }
  }

  // Base class: a persistent array of Food objects.
  class FoodList {
    #key; #items;
    constructor(key){
      this.#key = key;
      this.#items = Storage.get(key, []).map(o => new Food(o));
    }
    get limit(){ return Infinity; }              // subclasses override
    get items(){ return [...this.#items]; }
    has(food){ return this.#items.some(f => f.isSame(food)); }
    add(food){
      this.#items = [food, ...this.#items.filter(f => !f.isSame(food))].slice(0, this.limit);
      this.#save();
    }
    remove(food){
      this.#items = this.#items.filter(f => !f.isSame(food));
      this.#save();
    }
    #save(){ Storage.set(this.#key, this.#items); }
  }
  class FavoriteList extends FoodList {
    constructor(){ super('favs'); }
    toggle(food){ if(this.has(food)) this.remove(food); else this.add(food); }
  }
  class HistoryList extends FoodList {
    constructor(){ super('hist'); }
    get limit(){ return 8; }
  }

  class Preferences {
    constructor(){
      const s = Storage.get('prefs', {});
      this.goal = s.goal || 2000;
      this.diets = Array.isArray(s.diets) ? s.diets : [];
      this.allergens = Array.isArray(s.allergens) ? s.allergens : [];
      this.unit = s.unit === 'oz' ? 'oz' : 'g';
      this.theme = s.theme === 'light' ? 'light' : 'dark';
    }
    #toggle(arr, v){ const i = arr.indexOf(v); if(i >= 0) arr.splice(i, 1); else arr.push(v); this.save(); }
    toggleDiet(id){ this.#toggle(this.diets, id); }
    toggleAllergen(a){ this.#toggle(this.allergens, a); }
    setGoal(v){ this.goal = clamp(parseInt(v, 10) || 2000, 800, 6000); this.save(); }
    setUnit(u){ this.unit = u; this.save(); }
    toggleTheme(){ this.theme = this.theme === 'dark' ? 'light' : 'dark'; this.save(); }
    save(){ Storage.set('prefs', { goal:this.goal, diets:this.diets, allergens:this.allergens, unit:this.unit, theme:this.theme }); }
  }

  class PlateItem {
    constructor(food, grams, on = true){ this.food = food; this.grams = grams; this.on = on; }
    get kcal(){ return Math.round(this.food.amount('calories', this.grams)); }
  }

  class Plate {
    #items = [];    // PlateItem[]
    get items(){ return [...this.#items]; }
    get isEmpty(){ return this.#items.length === 0; }
    get active(){ return this.#items.filter(i => i.on); }
    load(items){ this.#items = items; }
    clear(){ this.#items = []; }
    setOn(i, on){ this.#items[i].on = on; }
    setGrams(i, g){ this.#items[i].grams = clamp(Math.round(g), 1, 2000); }

    totals(){
      return this.active.reduce((t, i) => {
        const f = i.food, kcal = f.amount('calories', i.grams);
        return { kcal:t.kcal + kcal, p:t.p + f.amount('protein', i.grams), c:t.c + f.amount('carbs', i.grams),
                 f:t.f + f.amount('fat', i.grams), scoreW:t.scoreW + f.score * kcal, w:t.w + kcal };
      }, { kcal:0, p:0, c:0, f:0, scoreW:0, w:0 });
    }
    // Calorie-weighted score turned into a letter grade
    grade(){
      const a = this.active;
      if(!a.length) return '–';
      const t = this.totals();
      const score = t.w ? t.scoreW / t.w : a.reduce((s, i) => s + i.food.score, 0) / a.length;
      return Food.gradeFromScore(score);
    }
  }

  class Comparison {
    constructor(){ this.A = null; this.B = null; }
    set(slot, food){ this[slot] = food; }
    get ready(){ return !!(this.A && this.B); }
    rows(){
      return Config.CMP_ROWS.map(([label, key, unit, better]) => {
        const a = this.A[key], b = this.B[key];
        let winner = null;
        if(a !== b) winner = (better === 'low' ? a < b : a > b) ? 'A' : 'B';
        return { label, unit, a, b, winner };
      });
    }
    verdict(){
      const rows = this.rows();
      const wa = rows.filter(r => r.winner === 'A').length, wb = rows.filter(r => r.winner === 'B').length;
      if(wa === wb) return 'It is a tie: each food wins on the same number of nutrients.';
      return (wa > wb ? this.A.name : this.B.name) + ' is better on ' + Math.max(wa, wb) + ' of ' + rows.length + ' nutrients.';
    }
  }

  // ===================================================================
  // SERVICES
  // ===================================================================
  class Channel {
    #ctrl = null;
    constructor(key, buttonId){
      this.status = $(key + 'Status');
      this.err = $(key + 'Err');
      this.errText = $(key + 'ErrText');
      this.btn = $(buttonId);
      $(key + 'Cancel').addEventListener('click', () => this.abort());
    }
    setBusy(busy){ this.btn.disabled = busy; this.status.classList.toggle('show', busy); }
    showError(msg){ this.errText.textContent = msg; this.err.classList.add('show'); }
    hideError(){ this.err.classList.remove('show'); }
    begin(){ this.#ctrl = new AbortController(); return this.#ctrl; }
    end(){ this.#ctrl = null; }
    abort(){ if(this.#ctrl) this.#ctrl.abort(); }
  }

  class Analyzer {
    static FOOD_FIELDS =
      '"name":"string","category":"Fruit|Vegetable|Protein|Grain|Dairy|Nut|Dish|Snack|Beverage",' +
      '"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,' +
      '"sodium":number,"vitaminC":number,"potassium":number,"score":number,' +
      '"grade":"A+|A|B+|B|C|D","gradeLabel":"Superfood|Excellent|Good|Moderate|Limit","vegetarian":boolean,' +
      '"allergens":["fish","shellfish","peanuts","tree nuts","dairy","eggs","gluten","soy","sesame"],' +
      '"swaps":[{"name":"string","grade":"A+|A|B+|B","note":"short reason"}],' +
      '"insight":"one short sentence about health impact"';
    static FOOD_RULES =
      'Rules: all nutrient values are per 100g (sodium, vitaminC and potassium in mg). ' +
      '"score" is a health score from 0 to 100. "allergens" lists only the allergens that apply, otherwise []. ' +
      '"swaps" lists up to 3 healthier alternatives, or [] if the grade is A+ or A. ';

    static textPrompt(hint){
      return 'You are a nutrition analyzer. Identify the food item. The user typed: "' + hint + '".\n\n' +
        'Reply with ONLY a valid JSON object, no markdown, no code fences, using exactly this shape:\n{' + Analyzer.FOOD_FIELDS + '}\n' +
        Analyzer.FOOD_RULES + 'If you cannot identify the food, reply with ONLY: {"error":"Could not identify food"}';
    }
    static imagePrompt(){
      return 'You are a nutrition analyzer. Identify every distinct food visible in the photo (at most 6).\n\n' +
        'Reply with ONLY a valid JSON object, no markdown, no code fences, using exactly this shape:\n' +
        '{"items":[{' + Analyzer.FOOD_FIELDS + ',"grams":number}]}\n' + Analyzer.FOOD_RULES +
        '"grams" is your estimate of the visible portion in grams. ' +
        'If you cannot identify any food, reply with ONLY: {"error":"Could not identify food"}';
    }
    static extractJson(text){
      const t = String(text).replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
      const s = t.indexOf('{'), e = t.lastIndexOf('}');
      if(s < 0 || e <= s) return null;
      try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
    }
    static errorMessage(err){
      return err.name === 'AbortError' ? 'Request timed out. Please try again.'
        : (err.message || 'Network error. Please check your connection.');
    }

    // Sends the request and returns the raw reply text
    async request(channel, { formData, jsonBody }){
      channel.hideError();
      channel.setBusy(true);
      const controller = channel.begin();
      const timer = setTimeout(() => controller.abort(), Config.TIMEOUT_MS);
      try {
        const opts = { method:'POST', signal:controller.signal };
        if(formData) opts.body = formData;
        else { opts.headers = { 'Content-Type':'application/json' }; opts.body = JSON.stringify(jsonBody); }

        const res = await fetch(Config.ENDPOINT, opts);
        clearTimeout(timer);
        let data = null;
        try { data = await res.json(); } catch { data = null; }

        if(!res.ok) throw new Error(this.#httpMessage(res.status, (data && data.error) || ''));
        if(!data || typeof data.reply !== 'string') throw new Error('Unexpected response from the analyzer.');
        return data.reply;
      } finally {
        clearTimeout(timer);
        channel.setBusy(false);
        channel.end();
      }
    }

    #httpMessage(status, rawMsg){
      if(/philippin|location|access denied|verify/i.test(rawMsg)){
        return 'This service is available only to visitors inside the Philippines. '
          + 'If you are in the Philippines, please turn off any VPN, proxy, or private-relay '
          + 'and make sure your connection uses a Philippine IP.';
      }
      if(status === 403) return 'Access denied. This service is available only in the Philippines. '
        + 'If you are in the Philippines, disable any VPN or proxy and try again.';
      if(status === 413) return 'Image or text is too large. Try a smaller photo or shorter text.';
      if(status === 415) return 'Unsupported file type. Please use JPG, PNG, GIF, or WebP.';
      if(status === 429) return 'Too many requests. Please wait a minute and try again.';
      if(status === 502 || status === 503) return 'The service is temporarily unavailable or your location could not be verified. Please try again shortly.';
      return rawMsg || ('Request failed (' + status + ').');
    }

    #parse(raw, channel){
      const p = Analyzer.extractJson(raw);
      if(p && p.error){ channel.showError('Could not identify that food. Try another photo or search by name.'); return null; }
      if(!p){ channel.showError('Could not read the analysis. Please try again or search by name.'); return null; }
      return p;
    }

    // Text search -> Food (or null after showing an error)
    async analyzeName(channel, name){
      try {
        const reply = await this.request(channel, { jsonBody:{ messages:[{ role:'user', content:Analyzer.textPrompt(name) }], max_tokens:900 } });
        const p = this.#parse(reply, channel);
        if(!p) return null;
        if(typeof p.name === 'string' && p.name.trim()) return new Food(p);
        channel.showError('Could not identify that food. Try another search.');
        return null;
      } catch(err){ channel.showError(Analyzer.errorMessage(err)); return null; }
    }

    // Photo -> array of PlateItem (or null after showing an error)
    async analyzeImage(channel, file){
      try {
        const form = new FormData();
        form.append('message', Analyzer.imagePrompt());
        form.append('image', file, 'food.jpg');
        const reply = await this.request(channel, { formData:form });
        const p = this.#parse(reply, channel);
        if(!p) return null;
        const raw = Array.isArray(p.items) ? p.items : (typeof p.name === 'string' ? [p] : []);
        const items = raw.filter(i => i && typeof i.name === 'string' && i.name.trim()).slice(0, 6)
          .map(i => new PlateItem(new Food(i), clamp(Math.round(i.grams) || 100, 1, 2000)));
        if(!items.length){ channel.showError('Could not identify that food. Try another photo or search by name.'); return null; }
        return items;
      } catch(err){ channel.showError(Analyzer.errorMessage(err)); return null; }
    }
  }

  // ===================================================================
  // APP (controller + view)
  // ===================================================================
  class App {
    constructor(){
      // models and services
      this.prefs = new Preferences();
      this.log = new FoodLog();
      this.favs = new FavoriteList();
      this.hist = new HistoryList();
      this.plate = new Plate();
      this.cmp = new Comparison();
      this.analyzer = new Analyzer();

      // request channels (busy / error UI)
      this.ch = {
        text:  new Channel('text',  'textBtn'),
        image: new Channel('image', 'imageBtn'),
        cmpA:  new Channel('cmpA',  'cmpABtn'),
        cmpB:  new Channel('cmpB',  'cmpBBtn')
      };

      // state
      this.food = null;        // Food shown in the result card
      this.grams = 100;
      this.imageFile = null;

      this.bind();
      this.applyTheme();
      this.renderPrefs();
      this.applyUnit();
      this.renderStrip();
      this.renderToday();
      this.setView('search');
    }

    // ---------- events ----------
    bind(){
      document.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => this.setView(b.dataset.view)));
      $('themeBtn').addEventListener('click', () => { this.prefs.toggleTheme(); this.applyTheme(); });
      document.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => {
        this.prefs.setUnit(b.dataset.unit); this.applyUnit(); this.renderPlate();
      }));

      // delegated clicks: chips, log rows, favorites, history
      document.addEventListener('click', e => {
        const d = e.target.closest('[data-diet]');
        if(d){ this.prefs.toggleDiet(d.dataset.diet); this.renderPrefs(); if(this.food) this.renderTags(); return; }
        const a = e.target.closest('[data-allergen]');
        if(a){ this.prefs.toggleAllergen(a.dataset.allergen); this.renderPrefs(); if(this.food) this.renderTags(); return; }
        const rm = e.target.closest('[data-rm]');
        if(rm){ this.log.removeAt(+rm.dataset.rm); this.renderStrip(); this.renderToday(); return; }
        const fv = e.target.closest('[data-fav]');
        if(fv){ this.setView('search'); this.renderFood(this.favs.items[+fv.dataset.fav]); return; }
        const hs = e.target.closest('[data-hist]');
        if(hs){ this.setView('search'); this.renderFood(this.hist.items[+hs.dataset.hist]); }
      });
      $('goalInput').addEventListener('change', () => {
        this.prefs.setGoal($('goalInput').value); $('goalInput').value = this.prefs.goal;
        this.renderStrip(); this.renderToday();
      });
      $('clearLog').addEventListener('click', () => { this.log.clearToday(); this.renderStrip(); this.renderToday(); });

      // search
      $('textBtn').addEventListener('click', () => this.analyzeText());
      $('foodInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); this.analyzeText(); } });

      // result card
      $('servingInput').addEventListener('input', () => {
        const v = parseFloat($('servingInput').value);
        if(!isFinite(v) || v <= 0) return;
        this.grams = clamp(Math.round(this.prefs.unit === 'oz' ? v * Config.OZ : v), 1, 2000);
        this.updateNutrients();
      });
      $('servingInput').addEventListener('change', () => this.showServing());
      const step = () => this.prefs.unit === 'oz' ? Config.OZ / 2 : 10;
      $('servMinus').addEventListener('click', () => this.setGrams(this.grams - step()));
      $('servPlus').addEventListener('click', () => this.setGrams(this.grams + step()));
      $('favBtn').addEventListener('click', () => { if(this.food){ this.favs.toggle(this.food); this.syncFav(); } });
      $('addBtn').addEventListener('click', () => { if(this.food){ this.addEntry(this.food, this.grams); this.flash($('addBtn'), 'Added to today'); } });
      $('compareBtn').addEventListener('click', () => {
        if(!this.food) return;
        this.cmp.set('A', this.food); $('cmpAInput').value = this.food.name; this.setView('compare');
      });

      // compare
      ['A','B'].forEach(s => {
        $('cmp' + s + 'Btn').addEventListener('click', () => this.analyzeSlot(s));
        $('cmp' + s + 'Input').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); this.analyzeSlot(s); } });
      });

      // photo
      const zone = $('uploadZone'), input = $('fileInput');
      zone.addEventListener('click', () => input.click());
      zone.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); input.click(); } });
      ['dragenter','dragover'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag'); }));
      ['dragleave','drop'].forEach(evt => zone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag'); }));
      zone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if(f) this.handleFile(f); });
      input.addEventListener('change', e => { const f = e.target.files[0]; if(f) this.handleFile(f); input.value = ''; });
      $('changeBtn').addEventListener('click', () => input.click());
      $('removeBtn').addEventListener('click', () => this.removePhoto());
      $('imageBtn').addEventListener('click', () => this.analyzeImage());
      document.querySelectorAll('.chip[data-sample]').forEach(chip =>
        chip.addEventListener('click', () => this.loadSample(chip.dataset.sample)));

      // plate
      $('plateList').addEventListener('change', e => {
        const c = e.target.dataset.pc, g = e.target.dataset.pg;
        if(c !== undefined){ this.plate.setOn(+c, e.target.checked); this.renderPlate(); }
        if(g !== undefined){
          const v = parseFloat(e.target.value);
          if(isFinite(v) && v > 0) this.plate.setGrams(+g, this.prefs.unit === 'oz' ? v * Config.OZ : v);
          this.renderPlate();
        }
      });
      $('plateAdd').addEventListener('click', () => {
        this.plate.active.forEach(i => this.addEntry(i.food, i.grams));
        this.flash($('plateAdd'), 'Added to today');
      });
    }

    // ---------- views ----------
    currentView(){ return (document.querySelector('.navbtn.active') || {}).dataset.view || 'search'; }
    setView(name){
      document.querySelectorAll('.navbtn').forEach(b => {
        const on = b.dataset.view === name;
        b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
      });
      Config.VIEWS.forEach(v => $('view-' + v).classList.toggle('active', v === name));
      if(name === 'today') this.renderToday();
      if(name === 'compare') this.renderCompare();
      this.syncResult(name);
    }
    syncResult(name){
      const v = name || this.currentView();
      const resultView = v === 'search' || v === 'photo';
      $('result').hidden = !(resultView && this.food);
      $('emptyState').hidden = !(resultView && !this.food && !(v === 'photo' && !this.plate.isEmpty));
    }

    // ---------- preferences, theme, units ----------
    renderPrefs(){
      const chip = (label, pressed, attr) => `<button type="button" class="chip" aria-pressed="${pressed}" ${attr}>${esc(label)}</button>`;
      const diets = Config.DIETS.map(d => chip(d.label, this.prefs.diets.includes(d.id), `data-diet="${d.id}"`)).join('');
      $('dietFilters').innerHTML = diets;
      $('dietPrefs').innerHTML = diets;
      $('allergenPrefs').innerHTML = Config.ALLERGENS.map(a =>
        chip(a.charAt(0).toUpperCase() + a.slice(1), this.prefs.allergens.includes(a), `data-allergen="${a}"`)).join('');
      $('goalInput').value = this.prefs.goal;
    }
    applyTheme(){
      document.documentElement.setAttribute('data-theme', this.prefs.theme);
      const next = this.prefs.theme === 'dark' ? 'Light' : 'Dark';
      $('themeBtn').textContent = next;
      $('themeBtn').setAttribute('aria-label', 'Switch to ' + next.toLowerCase() + ' theme');
    }
    applyUnit(){
      document.querySelectorAll('[data-unit]').forEach(b => b.setAttribute('aria-pressed', b.dataset.unit === this.prefs.unit));
      $('unitLbl').textContent = this.prefs.unit;
      this.showServing();
    }

    // ---------- result card ----------
    showServing(){
      const oz = this.prefs.unit === 'oz';
      $('servingInput').value = oz ? Math.round(this.grams / Config.OZ * 10) / 10 : Math.round(this.grams);
      $('servingInput').step = oz ? '0.1' : '1';
    }
    setGrams(g){ this.grams = clamp(Math.round(g), 1, 2000); this.showServing(); this.updateNutrients(); }

    renderTags(){
      const f = this.food; if(!f) return;
      const flagged = f.flaggedAllergens(this.prefs.allergens);
      $('allergenRow').innerHTML = f.allergens.length
        ? '<span>Allergens</span>' + f.allergens.map(a => `<span class="tag ${flagged.includes(a) ? 'bad' : 'warn'}">${esc(a)}</span>`).join('')
        : '';
      const warn = $('allergenWarn');
      warn.hidden = !flagged.length;
      warn.textContent = flagged.length ? 'Contains ' + flagged.join(', ') + ', which you flagged.' : '';
      $('fitRow').innerHTML = this.prefs.diets.length
        ? '<span>Your diet</span>' + this.prefs.diets.map(id => {
            const rule = Config.DIETS.find(d => d.id === id), ok = f.fits(rule);
            return `<span class="tag ${ok ? '' : 'off'}">${ok ? 'Fits' : 'Not'} ${esc(rule.label.toLowerCase())}</span>`;
          }).join('')
        : '';
    }

    setGradeBadge(el, grade){
      el.textContent = grade;
      el.classList.remove('tone-good', 'tone-mid', 'tone-bad');
      el.classList.add(Food.toneOf(grade));
    }

    renderFood(food, grams = 100){
      this.food = food;
      this.grams = grams;
      $('foodName').textContent = food.name;
      $('foodCat').textContent = food.category;
      this.setGradeBadge($('gradeBadge'), food.grade);
      $('scoreNum').textContent = food.score;
      $('breakdown').innerHTML = food.breakdown().map(([label, v]) =>
        `<div class="dv"><div class="dv-top"><span>${label}</span><b>${v}</b></div><div class="track"><div style="width:${v}%;background:${v >= 60 ? 'var(--accent)' : 'var(--warn)'}"></div></div></div>`).join('');
      $('insightText').textContent = food.insight;
      $('swapsCard').hidden = !food.hasSwaps;
      $('swapsList').innerHTML = food.hasSwaps
        ? food.swaps.map(s => `<li><span>${esc(s.name)}<br><span class="muted">${esc(s.note)}</span></span><b>${esc(s.grade)}</b></li>`).join('')
        : '';
      this.syncFav();
      this.renderTags();
      this.showServing();
      this.updateNutrients();
      this.hist.add(food);
      this.syncResult();
      $('result').scrollIntoView({ behavior:'smooth', block:'nearest' });
    }

    updateNutrients(){
      const f = this.food, g = this.grams; if(!f) return;
      $('calVal').textContent = Math.round(f.amount('calories', g)).toLocaleString();

      const split = f.macroSplit(g);
      $('barP').style.width = split.p + '%'; $('barC').style.width = split.c + '%'; $('barF').style.width = split.f + '%';
      $('pctP').textContent = split.p + '%'; $('pctC').textContent = split.c + '%'; $('pctF').textContent = split.f + '%';
      $('gP').textContent = fmt(f.amount('protein', g)) + ' g';
      $('gC').textContent = fmt(f.amount('carbs', g)) + ' g';
      $('gF').textContent = fmt(f.amount('fat', g)) + ' g';

      const dv = [['Protein','protein','var(--accent)'], ['Fiber','fiber','var(--accent)'], ['Fat','fat','var(--bad)'],
                  ['Sodium','sodium','var(--warn)'], ['Sugar','sugar','var(--bad)'], ['Carbs','carbs','var(--warn)']];
      $('dvGrid').innerHTML = dv.map(([label, key, color]) => {
        const pct = f.dailyValue(key, g);
        return `<div class="dv"><div class="dv-top"><span>${label}</span><b>${pct}%</b></div><div class="track"><div style="width:${Math.min(100, pct)}%;background:${color}"></div></div></div>`;
      }).join('');

      const tiles = [['Fiber','fiber','g'], ['Sugar','sugar','g'], ['Sodium','sodium','mg'], ['Vitamin C','vitaminC','mg'], ['Potassium','potassium','mg']];
      $('nutrientGrid').innerHTML = tiles.map(([label, key, unit]) =>
        `<div class="nut"><div class="lbl">${label}</div><div class="val">${fmt(f.amount(key, g))}<span class="unit">${unit}</span></div></div>`).join('');
    }

    syncFav(){
      const on = !!this.food && this.favs.has(this.food);
      $('favBtn').setAttribute('aria-pressed', on);
      $('favBtn').setAttribute('aria-label', on ? 'Remove from favorites' : 'Save to favorites');
    }

    // ---------- daily log ----------
    addEntry(food, grams){
      this.log.add(LogEntry.fromFood(food, grams));
      this.renderStrip(); this.renderToday();
    }
    flash(btn, text){
      const old = btn.textContent; btn.textContent = text; btn.disabled = true;
      setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1400);
    }
    renderStrip(){
      const t = this.log.totals(), goal = this.prefs.goal, left = goal - t.kcal;
      $('stripBar').style.width = clamp(t.kcal / goal * 100, 0, 100) + '%';
      $('stripEaten').textContent = t.kcal.toLocaleString();
      $('stripGoal').textContent = goal.toLocaleString();
      $('stripLeft').textContent = left >= 0 ? left.toLocaleString() + ' left' : Math.abs(left).toLocaleString() + ' over';
    }
    renderToday(){
      const t = this.log.totals(), goal = this.prefs.goal;
      $('ringArc').setAttribute('stroke-dashoffset', 390 * (1 - clamp(t.kcal / goal, 0, 1)));
      $('ringNum').textContent = t.kcal.toLocaleString();
      $('ringSub').textContent = 'of ' + goal.toLocaleString() + ' kcal';
      $('ringSvg').setAttribute('aria-label', t.kcal + ' of ' + goal + ' calories today');

      const goals = { p:goal * 0.25 / 4, c:goal * 0.5 / 4, f:goal * 0.25 / 9 };
      $('macroGoals').innerHTML = [['Protein','p','var(--c-p)'], ['Carbs','c','var(--c-c)'], ['Fat','f','var(--c-f)']].map(([label, k, color]) =>
        `<div class="dv"><div class="dv-top"><span>${label} ${Math.round(t[k])} / ${Math.round(goals[k])} g</span><b>${Math.round(t[k] / goals[k] * 100)}%</b></div><div class="track"><div style="width:${clamp(t[k] / goals[k] * 100, 0, 100)}%;background:${color}"></div></div></div>`).join('');

      const entries = this.log.today;
      $('logList').innerHTML = entries.length
        ? entries.map((e, i) => `<li><span>${esc(e.name)} <span class="muted">${e.grams} g</span></span><span><b>${e.kcal}</b> kcal <button class="x" type="button" data-rm="${i}" aria-label="Remove ${esc(e.name)}">×</button></span></li>`).join('')
        : '<li class="list-empty">Nothing logged yet. Analyze a food and choose Add to today.</li>';

      const favs = this.favs.items, hist = this.hist.items;
      $('favList').innerHTML = favs.length
        ? favs.map((f, i) => `<button class="chip fav-chip" type="button" data-fav="${i}">${esc(f.name)}</button>`).join('')
        : '<span class="list-empty">Tap the star on a food to save it here.</span>';
      $('histList').innerHTML = hist.length
        ? hist.map((f, i) => `<li><button class="rowbtn" type="button" data-hist="${i}">${esc(f.name)}</button><b>${esc(f.grade)}</b></li>`).join('')
        : '<li class="list-empty">Foods you analyze will show up here.</li>';
    }

    // ---------- text search ----------
    async analyzeText(){
      const q = $('foodInput').value.trim();
      if(!q){ this.ch.text.showError('Please enter a food name.'); return; }
      const food = await this.analyzer.analyzeName(this.ch.text, q);
      if(food) this.renderFood(food);
    }

    // ---------- compare ----------
    async analyzeSlot(slot){
      const q = $('cmp' + slot + 'Input').value.trim();
      const channel = this.ch['cmp' + slot];
      if(!q){ channel.showError('Please enter a food name.'); return; }
      const food = await this.analyzer.analyzeName(channel, q);
      if(food){ this.cmp.set(slot, food); this.renderCompare(); }
    }
    renderCompare(){
      const out = $('cmpOut');
      if(!this.cmp.ready){ out.innerHTML = '<div class="empty">Add two foods to compare them per 100 g.</div>'; return; }
      const { A, B } = this.cmp;
      const rows = this.cmp.rows().map(r => {
        const mark = w => r.winner === w ? ' <span aria-label="better">▲</span>' : '';
        return `<tr><th scope="row">${r.label}</th>` +
          `<td class="${r.winner === 'A' ? 'win' : ''}">${fmt(r.a)} ${r.unit}${mark('A')}</td>` +
          `<td class="${r.winner === 'B' ? 'win' : ''}">${fmt(r.b)} ${r.unit}${mark('B')}</td></tr>`;
      }).join('');
      const head = f => `<span class="gcell">${esc(f.name)} <span class="grade ${f.tone}">${esc(f.grade)}</span></span>`;
      out.innerHTML = `<table class="cmp-table"><thead><tr><th scope="col"><span class="muted" style="font-size:.78rem">Per 100 g</span></th><th scope="col">${head(A)}</th><th scope="col">${head(B)}</th></tr></thead><tbody>${rows}</tbody></table>` +
        `<div class="insight verdict"><b>Verdict.</b> ${esc(this.cmp.verdict())}</div>`;
    }

    // ---------- photo ----------
    static resizeImage(file, maxSide = 1280, quality = 0.85){
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not process image.')), 'image/jpeg', quality);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image file.')); };
        img.src = url;
      });
    }
    resetPhotoResults(){
      this.food = null; this.plate.clear();
      $('plate').hidden = true;
      this.syncResult();
    }
    showPreview(file){
      this.imageFile = file;
      $('previewImg').src = URL.createObjectURL(file);
      $('uploadZone').style.display = 'none';
      $('previewWrap').classList.add('show');
    }
    async handleFile(file){
      const ch = this.ch.image;
      ch.hideError();
      if(!['image/jpeg','image/png','image/gif','image/webp'].includes(file.type)){ ch.showError('Please choose a JPG, PNG, GIF, or WebP image.'); return; }
      if(file.size > 5 * 1024 * 1024){ ch.showError('Image is larger than 5MB. Please choose a smaller photo.'); return; }
      try {
        const resized = await App.resizeImage(file);
        this.showPreview(new File([resized], 'food.jpg', { type:'image/jpeg' }));
        this.resetPhotoResults();
      } catch(err){ ch.showError(err.message || 'Could not process this image.'); }
    }
    removePhoto(){
      this.imageFile = null;
      $('previewImg').src = '';
      $('previewWrap').classList.remove('show');
      $('uploadZone').style.display = 'block';
      this.ch.image.hideError();
      this.resetPhotoResults();
    }
    async analyzeImage(){
      const ch = this.ch.image;
      if(!this.imageFile){ ch.showError('Please choose a photo first.'); return; }
      const items = await this.analyzer.analyzeImage(ch, this.imageFile);   // PlateItem[] | null
      if(!items) return;
      if(items.length === 1){
        this.plate.clear(); $('plate').hidden = true;
        this.renderFood(items[0].food, items[0].grams);
      } else {
        this.food = null;
        this.plate.load(items);
        this.renderPlate();
        this.syncResult();
      }
    }
    async loadSample(key){
      const emojiMap = { apple:'🍎', friedchicken:'🍗', pizza:'🍕', salmon:'🐟', broccoli:'🥦' };
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#eef5f1"/><text x="240" y="200" font-size="150" text-anchor="middle">${emojiMap[key] || '🍽️'}</text></svg>`;
      try {
        const resized = await App.resizeImage(new Blob([svg], { type:'image/svg+xml' }));
        this.showPreview(new File([resized], 'sample.jpg', { type:'image/jpeg' }));
        this.ch.image.hideError();
        this.analyzeImage();
      } catch { this.ch.image.showError('Could not load sample. Try uploading a photo.'); }
    }

    // ---------- plate ----------
    renderPlate(){
      if(this.plate.isEmpty){ $('plate').hidden = true; return; }
      $('plate').hidden = false;
      const oz = this.prefs.unit === 'oz';
      const show = g => oz ? Math.round(g / Config.OZ * 10) / 10 : Math.round(g);
      $('plateList').innerHTML = this.plate.items.map((it, i) =>
        `<li><label><input type="checkbox" data-pc="${i}" ${it.on ? 'checked' : ''}> ${esc(it.food.name)}</label>` +
        `<span><input class="gin" type="number" min="0.1" step="${oz ? '0.1' : '1'}" data-pg="${i}" value="${show(it.grams)}" aria-label="Portion of ${esc(it.food.name)} in ${this.prefs.unit}"> ${this.prefs.unit}</span>` +
        `<b>${it.kcal} kcal</b></li>`).join('');
      const t = this.plate.totals();
      $('plateKcal').textContent = Math.round(t.kcal).toLocaleString();
      $('plateMacros').textContent = 'Protein ' + fmt(t.p) + ' g, carbs ' + fmt(t.c) + ' g, fat ' + fmt(t.f) + ' g';
      this.setGradeBadge($('plateGrade'), this.plate.grade());
      $('plateAdd').disabled = this.plate.active.length === 0;
    }
  }

  new App();
})();
