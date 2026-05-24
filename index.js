const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');

const TOKEN         = process.env.TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY; // ta clé API Anthropic
if (!TOKEN)         { console.error("❌ TOKEN manquant"); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error("❌ ANTHROPIC_KEY manquant"); process.exit(1); }

const DB_FILE = './ia_config.json';
function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ channels: [], personality: "Tu es un assistant Discord sympa, drôle et utile. Réponds toujours en français. Sois concis (max 1500 caractères)." }));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// Historique des conversations par salon (max 10 messages)
const history = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel, Partials.Message],
});

const commands = [
  new SlashCommandBuilder().setName('ia-setchannel').setDescription('Définir un salon où l\'IA répond automatiquement 🤖')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true)),

  new SlashCommandBuilder().setName('ia-removechannel').setDescription('Retirer un salon IA 🗑️')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true)),

  new SlashCommandBuilder().setName('ia-personality').setDescription('Changer la personnalité de l\'IA 🎭')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('personnalité').setDescription('Décris la personnalité de l\'IA').setRequired(true)),

  new SlashCommandBuilder().setName('ia-reset').setDescription('Réinitialiser l\'historique de conversation 🔄')
    .addChannelOption(o => o.setName('salon').setDescription('Salon (laisser vide = salon actuel)')),

  new SlashCommandBuilder().setName('ia-ask').setDescription('Poser une question à l\'IA 💬')
    .addStringOption(o => o.setName('question').setDescription('Ta question').setRequired(true)),

  new SlashCommandBuilder().setName('ia-imagine').setDescription('Demander à l\'IA de générer un texte créatif ✨')
    .addStringOption(o => o.setName('prompt').setDescription('Ce que tu veux générer').setRequired(true)),

  new SlashCommandBuilder().setName('ia-status').setDescription('Voir la configuration de l\'IA ⚙️')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('cmd').setDescription('Liste des commandes 📋'),
];

// ── Appel API Anthropic ──────────────────────────────────────
async function askClaude(messages, system) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

// ── Gestion historique ───────────────────────────────────────
function getHistory(channelId) { return history.get(channelId) || []; }
function addToHistory(channelId, role, content) {
  const hist = getHistory(channelId);
  hist.push({ role, content });
  if (hist.length > 20) hist.splice(0, 2); // garder max 10 échanges
  history.set(channelId, hist);
}

client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} connecté`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(c => c.toJSON()) });
  console.log('✅ Slash commands enregistrées');
  client.user.setActivity('🤖 IA Active', { type: 3 });
});

// ── Réponse automatique dans les salons configurés ───────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const db = loadDB();
  const isMentioned = message.mentions.has(client.user);
  const isIAChannel = db.channels?.includes(message.channel.id);

  if (!isMentioned && !isIAChannel) return;

  // Ignorer si le message est trop court
  const content = message.content.replace(`<@${client.user.id}>`, '').trim();
  if (!content) return;

  await message.channel.sendTyping();

  try {
    addToHistory(message.channel.id, 'user', content);
    const hist = getHistory(message.channel.id);
    const response = await askClaude(hist, db.personality || "Tu es un assistant Discord sympa et utile. Réponds en français, sois concis.");
    addToHistory(message.channel.id, 'assistant', response);

    // Découper si trop long
    if (response.length <= 2000) {
      await message.reply(response);
    } else {
      const chunks = response.match(/.{1,1900}/gs) || [];
      for (const chunk of chunks) await message.channel.send(chunk);
    }
  } catch (err) {
    console.error(err);
    message.reply(`❌ Erreur IA : ${err.message}`).catch(() => {});
  }
});

// ── Slash commands ───────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, options, channel } = interaction;

  try {
    const db = loadDB();

    // SET CHANNEL
    if (commandName === 'ia-setchannel') {
      const salon = options.getChannel('salon');
      if (!db.channels) db.channels = [];
      if (db.channels.includes(salon.id)) return interaction.reply({ content: '❌ Ce salon est déjà configuré.', ephemeral: true });
      db.channels.push(salon.id);
      saveDB(db);
      return interaction.reply({ content: `✅ L'IA répondra automatiquement dans ${salon}.` });
    }

    // REMOVE CHANNEL
    if (commandName === 'ia-removechannel') {
      const salon = options.getChannel('salon');
      db.channels = (db.channels || []).filter(id => id !== salon.id);
      saveDB(db);
      return interaction.reply({ content: `✅ Salon ${salon} retiré.` });
    }

    // PERSONALITY
    if (commandName === 'ia-personality') {
      const perso = options.getString('personnalité');
      db.personality = perso + " Réponds toujours en français et sois concis.";
      saveDB(db);
      history.clear(); // reset tous les historiques
      return interaction.reply({ content: `✅ Personnalité mise à jour !\n> ${perso}` });
    }

    // RESET
    if (commandName === 'ia-reset') {
      const salon = options.getChannel('salon') || channel;
      history.delete(salon.id);
      return interaction.reply({ content: `✅ Historique de ${salon} réinitialisé.`, ephemeral: true });
    }

    // ASK
    if (commandName === 'ia-ask') {
      const question = options.getString('question');
      await interaction.deferReply();
      addToHistory(channel.id, 'user', question);
      const response = await askClaude(getHistory(channel.id), db.personality || "Tu es un assistant sympa. Réponds en français.");
      addToHistory(channel.id, 'assistant', response);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .addFields(
          { name: '❓ Question', value: question.slice(0, 1024) },
          { name: '🤖 Réponse', value: response.slice(0, 1024) },
        ).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // IMAGINE
    if (commandName === 'ia-imagine') {
      const prompt = options.getString('prompt');
      await interaction.deferReply();
      const messages = [{ role: 'user', content: `Génère de manière créative : ${prompt}` }];
      const response = await askClaude(messages, "Tu es un générateur de texte créatif. Sois inventif, détaillé et captivant. Réponds en français.");
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6).setTitle('✨ Génération créative')
        .addFields(
          { name: '🎯 Prompt', value: prompt.slice(0, 256) },
          { name: '📝 Résultat', value: response.slice(0, 1024) },
        ).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // STATUS
    if (commandName === 'ia-status') {
      const channels = (db.channels || []).map(id => `<#${id}>`).join(', ') || 'Aucun';
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71).setTitle('⚙️ Configuration IA')
        .addFields(
          { name: '📢 Salons actifs', value: channels },
          { name: '🎭 Personnalité', value: db.personality?.slice(0, 500) || 'Par défaut' },
          { name: '🧠 Modèle', value: 'Claude Haiku' },
        ).setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // CMD
    if (commandName === 'cmd') {
      const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle('🤖 Commandes — IA')
        .setDescription(
          '/ia-setchannel — Activer l\'IA dans un salon\n' +
          '/ia-removechannel — Désactiver l\'IA d\'un salon\n' +
          '/ia-personality — Changer la personnalité\n' +
          '/ia-reset — Réinitialiser l\'historique\n' +
          '/ia-ask — Poser une question\n' +
          '/ia-imagine — Génération créative\n' +
          '/ia-status — Voir la config\n' +
          '/cmd — Cette liste\n\n' +
          '💡 Tu peux aussi **mentionner le bot** dans n\'importe quel salon !'
        ).setFooter({ text: 'Propulsé par Claude (Anthropic)' });
      return interaction.reply({ embeds: [embed] });
    }

  } catch (err) {
    console.error(err);
    if (!interaction.replied && !interaction.deferred)
      interaction.reply({ content: `❌ Erreur : ${err.message}`, ephemeral: true });
  }
});

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);
client.login(TOKEN);
