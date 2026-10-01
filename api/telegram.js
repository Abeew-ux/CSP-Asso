import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { randomInt } from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ANNEE = process.env.ANNEE_SCOLAIRE || '2026-2027';
const EMAIL_DOMAIN = 'csp-asso.local';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---------- Telegram helpers ----------
async function send(chatId, text) {
  await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  });
}

async function sendFile(chatId, filename, content, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'text/csv' }), filename);
  await fetch(`${TG}/sendDocument`, { method: 'POST', body: form });
}

async function downloadFile(fileId) {
  const r = await fetch(`${TG}/getFile?file_id=${fileId}`).then((x) => x.json());
  if (!r.ok) throw new Error('Fichier introuvable sur Telegram');
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${r.result.file_path}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- utilitaires ----------
const norm = (s) =>
  String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

const cleanMatricule = (m) => String(m ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
const emailOf = (m) => `${m.toLowerCase()}@${EMAIL_DOMAIN}`;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans caractères ambigus (0/O, 1/I/L)
function genCode(len = 8) {
  let c = '';
  for (let i = 0; i < len; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return c;
}

function readSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  // lit toutes les feuilles (une par classe, par exemple), sauf « Instructions »
  const rows = [];
  for (const name of wb.SheetNames) {
    if (norm(name) === 'instructions') continue;
    rows.push(...XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' }));
  }
  // normalise les noms de colonnes
  return rows.map((r) => {
    const o = {};
    const labels = {};
    for (const [k, v] of Object.entries(r)) {
      o[norm(k)] = v;
      labels[norm(k)] = String(k).trim(); // garde les accents pour les noms de matières
    }
    Object.defineProperty(o, '__labels', { value: labels, enumerable: false });
    return o;
  });
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

async function eleveByMatricule(matricule) {
  const { data } = await db.from('eleves').select('id, matricule, nom, prenom, classe').eq('matricule', matricule).maybeSingle();
  return data;
}

// ---------- création d'élèves ----------
async function createEleve({ matricule, nom, prenom, classe }) {
  const code = genCode();
  const { data, error } = await db.auth.admin.createUser({
    email: emailOf(matricule),
    password: code,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  const { error: e2 } = await db.from('eleves').insert({ id: data.user.id, matricule, nom, prenom, classe });
  if (e2) {
    await db.auth.admin.deleteUser(data.user.id); // pas de compte orphelin
    throw new Error(e2.message);
  }
  return code;
}

async function cmdImportEleves(chatId, doc) {
  const rows = readSheet(await downloadFile(doc.file_id));
  const errors = [];
  const valid = [];
  const seen = new Set();
  rows.forEach((r, i) => {
    const line = i + 2;
    const matricule = cleanMatricule(r['matricule']);
    const nom = String(r['nom'] ?? '').trim();
    const prenom = String(r['prenom'] ?? '').trim();
    const classe = String(r['classe'] ?? '').trim();
    if (!nom && !prenom) return; // ligne vide ou matricule pré-rempli sans élève
    if (matricule.startsWith('EXEMPLE')) return;
    if (!matricule || !nom || !prenom || !classe) return errors.push(`Ligne ${line} : champ manquant`);
    if (seen.has(matricule)) return errors.push(`Ligne ${line} : matricule ${matricule} en double dans le fichier`);
    seen.add(matricule);
    valid.push({ matricule, nom, prenom, classe });
  });

  const results = await inBatches(valid, 8, async (e) => {
    try {
      const code = await createEleve(e);
      return { ...e, code };
    } catch (err) {
      return { ...e, error: /already|exist|duplicate/i.test(err.message) ? 'existe déjà' : err.message };
    }
  });

  const created = results.filter((r) => r.code);
  const failed = results.filter((r) => r.error);
  failed.forEach((f) => errors.push(`${f.matricule} : ${f.error}`));

  let msg = `Import terminé : ${created.length} élève(s) créé(s)`;
  if (errors.length) msg += `, ${errors.length} problème(s) :\n- ${errors.slice(0, 15).join('\n- ')}`;
  await send(chatId, msg);

  if (created.length) {
    const csv = ['matricule,nom,prenom,classe,code'].concat(
      created.map((c) => [c.matricule, c.nom, c.prenom, c.classe, c.code].map(csvCell).join(','))
    ).join('\n');
    await sendFile(chatId, 'codes_eleves.csv', '\uFEFF' + csv, 'Codes de connexion : à distribuer puis supprimer de la conversation.');
  }
}

async function cmdEleve(chatId, args) {
  const [m, nom, prenom, classe] = args.split('|').map((s) => s.trim());
  const matricule = cleanMatricule(m);
  if (!matricule || !nom || !prenom || !classe) return send(chatId, 'Format : /eleve matricule | nom | prénom | classe');
  try {
    const code = await createEleve({ matricule, nom, prenom, classe });
    await send(chatId, `Élève créé.\nMatricule : ${matricule}\nCode : ${code}`);
  } catch (e) {
    await send(chatId, `Échec : ${/already|exist|duplicate/i.test(e.message) ? 'ce matricule existe déjà' : e.message}`);
  }
}

async function cmdReset(chatId, args) {
  const matricule = cleanMatricule(args);
  const el = matricule && (await eleveByMatricule(matricule));
  if (!el) return send(chatId, 'Matricule introuvable. Format : /reset matricule');
  const code = genCode();
  const { error } = await db.auth.admin.updateUserById(el.id, { password: code });
  if (error) return send(chatId, `Échec : ${error.message}`);
  await send(chatId, `Nouveau code pour ${el.prenom} ${el.nom} (${matricule}) : ${code}`);
}

// ---------- notes ----------
async function cmdImportNotes(chatId, trimestre, doc) {
  if (!trimestre) return send(chatId, 'Précise le trimestre dans la légende : /import_notes T1');
  const rows = readSheet(await downloadFile(doc.file_id));
  const META = new Set(['matricule', 'nom', 'prenom', 'classe']);
  const errors = [];
  const entries = []; // { matricule, matiere, note, coefficient }
  const long = rows.length && 'matiere' in rows[0] && 'note' in rows[0];

  const parseNote = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  };

  rows.forEach((r, i) => {
    const line = i + 2;
    const matricule = cleanMatricule(r['matricule']);
    if (!matricule || matricule.startsWith('EXEMPLE')) return;
    const push = (matiere, raw, coef) => {
      const note = parseNote(raw);
      if (note === null) return;
      if (Number.isNaN(note) || note < 0 || note > 20) return errors.push(`Ligne ${line} (${matricule}) : note invalide pour ${matiere}`);
      const c = coef === undefined || coef === '' ? 1 : Number(String(coef).replace(',', '.'));
      entries.push({ matricule, matiere, note, coefficient: Number.isFinite(c) && c > 0 ? c : 1 });
    };
    if (long) push(String(r['matiere']).trim(), r['note'], r['coefficient']);
    else for (const [k, v] of Object.entries(r)) if (!META.has(k) && k) push(r.__labels[k], v);
  });

  // résolution des matricules
  const matricules = [...new Set(entries.map((e) => e.matricule))];
  const { data: eleves } = await db.from('eleves').select('id, matricule').in('matricule', matricules);
  const idOf = Object.fromEntries((eleves || []).map((e) => [e.matricule, e.id]));
  const unknown = matricules.filter((m) => !idOf[m]);
  unknown.forEach((m) => errors.push(`Matricule inconnu : ${m}`));

  const toSave = entries.filter((e) => idOf[e.matricule]).map((e) => ({
    eleve_id: idOf[e.matricule],
    matiere: e.matiere,
    trimestre,
    annee_scolaire: ANNEE,
    note: e.note,
    coefficient: e.coefficient,
  }));

  let saved = 0;
  for (let i = 0; i < toSave.length; i += 200) {
    const { error } = await db.from('notes').upsert(toSave.slice(i, i + 200), { onConflict: 'eleve_id,matiere,trimestre,annee_scolaire' });
    if (error) errors.push(`Erreur d'enregistrement : ${error.message}`);
    else saved += Math.min(200, toSave.length - i);
  }
  let msg = `Notes ${trimestre} : ${saved} note(s) enregistrée(s) pour ${new Set(toSave.map((t) => t.eleve_id)).size} élève(s).`;
  if (errors.length) msg += `\n${errors.length} problème(s) :\n- ${errors.slice(0, 15).join('\n- ')}`;
  await send(chatId, msg);
}

async function cmdNote(chatId, args) {
  const [m, matiere, trimestre, noteRaw] = args.split('|').map((s) => s.trim());
  const matricule = cleanMatricule(m);
  const note = Number(String(noteRaw).replace(',', '.'));
  if (!matricule || !matiere || !trimestre || !Number.isFinite(note) || note < 0 || note > 20)
    return send(chatId, 'Format : /note matricule | matière | trimestre | note (0 à 20)');
  const el = await eleveByMatricule(matricule);
  if (!el) return send(chatId, 'Matricule introuvable.');
  const { error } = await db.from('notes').upsert(
    { eleve_id: el.id, matiere, trimestre, annee_scolaire: ANNEE, note },
    { onConflict: 'eleve_id,matiere,trimestre,annee_scolaire' }
  );
  await send(chatId, error ? `Échec : ${error.message}` : `Note enregistrée : ${el.prenom} ${el.nom}, ${matiere} ${trimestre} = ${note}/20`);
}

// ---------- bulletins (PDF nommé MATRICULE_T1.pdf) ----------
async function handleBulletinPdf(chatId, doc) {
  const m = /^(.+)_(T[1-3])\.pdf$/i.exec(doc.file_name || '');
  if (!m) return send(chatId, `Nom de fichier non reconnu (${doc.file_name}). Utilise MATRICULE_T1.pdf, par exemple ELV001_T1.pdf`);
  const matricule = cleanMatricule(m[1]);
  const trimestre = m[2].toUpperCase();
  const el = await eleveByMatricule(matricule);
  if (!el) return send(chatId, `Matricule inconnu : ${matricule}`);
  const buf = await downloadFile(doc.file_id);
  const path = `${el.id}/${ANNEE}_${trimestre}.pdf`;
  const up = await db.storage.from('bulletins').upload(path, buf, { contentType: 'application/pdf', upsert: true });
  if (up.error) return send(chatId, `Échec envoi : ${up.error.message}`);
  const { error } = await db.from('bulletins').upsert(
    { eleve_id: el.id, trimestre, annee_scolaire: ANNEE, fichier_path: path },
    { onConflict: 'eleve_id,trimestre,annee_scolaire' }
  );
  await send(chatId, error ? `Échec : ${error.message}` : `Bulletin ${trimestre} enregistré pour ${el.prenom} ${el.nom} (${matricule}).`);
}

// ---------- actualités & infos ----------
async function cmdActu(chatId, args) {
  const parts = args.split('|').map((s) => s.trim());
  let categorie = 'Annonce officielle', titre, contenu;
  if (parts.length >= 3) [categorie, titre, contenu] = [parts[0], parts[1], parts.slice(2).join(' | ')];
  else [titre, contenu] = parts;
  if (!titre || !contenu) return send(chatId, 'Format : /actu Titre | Texte\nou : /actu Catégorie | Titre | Texte');
  const { error } = await db.from('actualites').insert({ titre, categorie, contenu });
  await send(chatId, error ? `Échec : ${error.message}` : 'Actualité publiée sur le site.');
}

async function cmdActus(chatId) {
  const { data } = await db.from('actualites').select('id, titre, created_at').order('created_at', { ascending: false }).limit(10);
  if (!data?.length) return send(chatId, 'Aucune actualité.');
  await send(chatId, data.map((a) => `${a.id.slice(0, 8)} : ${a.titre}`).join('\n') + '\n\nSupprimer : /suppr_actu identifiant');
}

async function cmdSupprActu(chatId, args) {
  const prefix = args.trim().toLowerCase();
  if (prefix.length < 6) return send(chatId, 'Format : /suppr_actu identifiant (voir /actus)');
  const { data } = await db.from('actualites').select('id, titre').order('created_at', { ascending: false }).limit(50);
  const hit = (data || []).filter((a) => a.id.startsWith(prefix));
  if (hit.length !== 1) return send(chatId, 'Identifiant introuvable ou ambigu.');
  const { error } = await db.from('actualites').delete().eq('id', hit[0].id);
  await send(chatId, error ? `Échec : ${error.message}` : `Supprimée : ${hit[0].titre}`);
}

async function cmdInfo(chatId, args) {
  const i = args.indexOf('|');
  const cle = norm(args.slice(0, i)).replace(/\s+/g, '_');
  const valeur = args.slice(i + 1).trim();
  if (i < 0 || !cle || !valeur) return send(chatId, 'Format : /info clé | valeur\nExemple : /info horaires | Lundi-Vendredi 7h30-17h');
  const { error } = await db.from('infos').upsert({ cle, valeur, updated_at: new Date().toISOString() });
  await send(chatId, error ? `Échec : ${error.message}` : `Info « ${cle} » mise à jour.`);
}

async function cmdInfos(chatId) {
  const { data } = await db.from('infos').select('cle, valeur').order('cle');
  await send(chatId, data?.length ? data.map((x) => `${x.cle} : ${x.valeur}`).join('\n') : 'Aucune info enregistrée.');
}

async function cmdInscriptions(chatId) {
  const { data } = await db.from('inscriptions').select('prenom_eleve, nom_eleve, classe_souhaitee, nom_parent, telephone, created_at').eq('statut', 'nouvelle').order('created_at', { ascending: false }).limit(15);
  if (!data?.length) return send(chatId, 'Aucune nouvelle demande d\'inscription.');
  await send(chatId, data.map((d) => `${d.prenom_eleve} ${d.nom_eleve} (${d.classe_souhaitee})\nParent : ${d.nom_parent}, ${d.telephone}`).join('\n\n'));
}

const HELP = `Commandes :
/actu Titre | Texte : publier une actualité
/actus : lister, /suppr_actu id : supprimer
/info clé | valeur : modifier une info du site (/infos pour la liste)
  clés : apropos, formations (une par ligne, « Titre : description »), adresse, telephone, email, horaires
/inscriptions : voir les nouvelles demandes d'inscription
/eleve matricule | nom | prénom | classe : créer un élève
/import_eleves : envoyer un fichier Excel/CSV avec cette légende
/import_notes T1 : fichier Excel/CSV de notes, avec cette légende
/note matricule | matière | trimestre | note
/reset matricule : nouveau code de connexion
Bulletins : envoie les PDF nommés MATRICULE_T1.pdf`;

// ---------- routeur ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.status(401).send('unauthorized');

  const msg = req.body?.message;
  if (!msg) return res.status(200).send('ok');
  const chatId = msg.chat.id;

  try {
    if (!ADMIN_IDS.includes(String(msg.from?.id))) {
      await send(chatId, 'Accès réservé aux administrateurs.');
      return res.status(200).send('ok');
    }

    const text = (msg.text || msg.caption || '').trim();
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();
    const args = text.slice(rawCmd.length).trim();
    const doc = msg.document;

    if (doc && /^(.+)_(T[1-3])\.pdf$/i.test(doc.file_name || '')) await handleBulletinPdf(chatId, doc);
    else if (doc && cmd === '/import_eleves') await cmdImportEleves(chatId, doc);
    else if (doc && cmd === '/import_notes') await cmdImportNotes(chatId, rest[0], doc);
    else if (doc) await send(chatId, 'Ajoute une légende : /import_eleves, /import_notes T1, ou nomme le PDF MATRICULE_T1.pdf');
    else if (cmd === '/start' || cmd === '/aide' || cmd === '/help') await send(chatId, HELP);
    else if (cmd === '/actu') await cmdActu(chatId, args);
    else if (cmd === '/actus') await cmdActus(chatId);
    else if (cmd === '/suppr_actu') await cmdSupprActu(chatId, args);
    else if (cmd === '/info') await cmdInfo(chatId, args);
    else if (cmd === '/infos') await cmdInfos(chatId);
    else if (cmd === '/inscriptions') await cmdInscriptions(chatId);
    else if (cmd === '/eleve') await cmdEleve(chatId, args);
    else if (cmd === '/reset') await cmdReset(chatId, args);
    else if (cmd === '/note') await cmdNote(chatId, args);
    else await send(chatId, 'Commande inconnue. Envoie /aide.');
  } catch (e) {
    console.error(e);
    await send(chatId, `Erreur : ${e.message}`);
  }
  res.status(200).send('ok');
}
