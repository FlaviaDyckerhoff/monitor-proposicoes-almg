const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'ALMG';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';


// ─── Configuração ────────────────────────────────────────────────────────────
const API_BASE = 'https://dadosabertos.almg.gov.br';
const ESTADO_PATH = path.join(__dirname, 'estado.json');
const ANO_ATUAL = new Date().getFullYear();
const ITENS_POR_PAGINA = 50;

// ─── Estado ──────────────────────────────────────────────────────────────────
function carregarEstado() {
  if (fs.existsSync(ESTADO_PATH)) {
    return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
}

// ─── Sleep (respeita rate limit da ALMG: mín 1s entre requisições) ───────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function montarLinkProposicao(item) {
  const tipo = encodeURIComponent(item.siglaTipoProjeto || item.tipoProjeto || 'OUTROS');
  const numero = encodeURIComponent(item.numero || '');
  const ano = encodeURIComponent(item.ano || ANO_ATUAL);
  return `https://www.almg.gov.br/projetos-de-lei/${tipo}/${numero}/${ano}`;
}

// ─── Busca proposições de uma página ─────────────────────────────────────────
async function buscarPagina(pagina) {
  const params = new URLSearchParams({
    ano: ANO_ATUAL,
    tp: ITENS_POR_PAGINA,
    p: pagina,
    ord: 0,       // 0 = data de publicação decrescente (mais recentes primeiro)
    formato: 'json'
  });

  const url = `${API_BASE}/api/v2/proposicoes/pesquisa/direcionada?${params}`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ao buscar página ${pagina}`);
  }

  const json = await resp.json();
  return json.resultado || {};
}

// ─── Busca todas as proposições novas ────────────────────────────────────────
async function buscarProposicoesNovas(vistas) {
  const visitasSet = new Set(vistas);
  const novas = [];
  let pagina = 1;
  let totalPaginas = 1;

  do {
    if (pagina > 1) await sleep(1200); // respeita rate limit (mín 1s)

    const resultado = await buscarPagina(pagina);
    const itens = resultado.listaItem || [];
    const total = resultado.noOcorrencias || 0;
    totalPaginas = Math.ceil(total / ITENS_POR_PAGINA);

    console.log(`Página ${pagina}/${totalPaginas} — ${itens.length} proposições`);

    let encontrouTodasVistas = false;

    for (const item of itens) {
      const id = item.codigo || `${item.siglaTipoProjeto}-${item.numero}-${item.ano}`;
      if (visitasSet.has(id)) {
        // Chegamos em proposições já conhecidas — podemos parar
        encontrouTodasVistas = true;
        break;
      }
      novas.push({
        id,
        tipo: item.siglaTipoProjeto || item.tipoProjeto || 'OUTROS',
        numero: item.numero || '',
        ano: item.ano || ANO_ATUAL,
        autor: item.autor || item.nome || 'Não informado',
        ementa: item.ementa || item.assunto || item.resumo || '',
        data: item.dataPublicacao || '',
        link: montarLinkProposicao(item)
      });
    }

    if (encontrouTodasVistas) break;
    pagina++;

  } while (pagina <= totalPaginas && pagina <= 20); // limite de segurança: 20 páginas

  return novas;
}

// ─── Monta o email ────────────────────────────────────────────────────────────
function montarEmail(proposicoes) {
  // Agrupa por tipo
  const grupos = {};
  for (const p of proposicoes) {
    const tipo = p.tipo || 'OUTROS';
    if (!grupos[tipo]) grupos[tipo] = [];
    grupos[tipo].push(p);
  }

  // Ordena tipos e dentro de cada tipo por número decrescente
  const tiposOrdenados = Object.keys(grupos).sort();
  for (const tipo of tiposOrdenados) {
    grupos[tipo].sort((a, b) => Number(b.numero) - Number(a.numero));
  }

  let html = `
    <div style="font-family: Arial, sans-serif; width: 100%; max-width: 920px; margin: 0 auto;">
      <h2 style="color: #1a3a5c; border-bottom: 2px solid #1a3a5c; padding-bottom: 8px;">
        🏛️ Assembleia Legislativa de Minas Gerais — ${proposicoes.length} nova${proposicoes.length > 1 ? 's' : ''} proposiç${proposicoes.length > 1 ? 'ões' : 'ão'} (${ANO_ATUAL})
      </h2>
  `;

  for (const tipo of tiposOrdenados) {
    const itens = grupos[tipo];
    html += `
      <h3 style="color: #2c5f8a; margin-top: 24px; margin-bottom: 8px;">
        ${tipo} <span style="font-weight:normal; font-size:0.9em;">(${itens.length})</span>
      </h3>
    `;
    for (const p of itens) {
      const dataFmt = p.data
        ? p.data.replace(/(\d{4})(\d{2})(\d{2})/, '$3/$2/$1')
        : '';
      html += `
        <div style="border-left: 3px solid #2c5f8a; padding: 8px 12px; margin-bottom: 10px; background: #f8fafc;">
          <div style="font-weight: bold;">
            <a href="${p.link}" style="color: #1a3a5c; text-decoration: none;">
              ${p.tipo} ${p.numero}/${p.ano}
            </a>
            ${dataFmt ? `<span style="font-weight:normal; color:#666; font-size:0.85em;"> — ${dataFmt}</span>` : ''}
          </div>
          <div style="color: #444; margin: 4px 0; font-size: 0.92em;">${p.ementa || '(sem ementa)'}</div>
          <div style="color: #666; font-size: 0.85em;">Autor: ${p.autor}</div>
        </div>
      `;
    }
  }

  html += `
      <hr style="margin-top: 30px; border: none; border-top: 1px solid #ddd;">
      <p style="color: #999; font-size: 0.8em; text-align: center;">
        Monitor automático — Assembleia Legislativa de Minas Gerais<br>
        Dados: <a href="https://dadosabertos.almg.gov.br" style="color:#999;">dadosabertos.almg.gov.br</a>
      </p>
    </div>
  `;

  return html;
}

// ─── Envia email ──────────────────────────────────────────────────────────────

const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra', 'BRT'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function radar03Identificacao(p) {
  return String(p?.identificacao ?? p?.proposicao ?? p?.rotulo ?? p?.titulo ?? '').trim();
}

function radar03Tipo(p) {
  const direto = String(p?.tipo ?? p?.sigla ?? '').trim();
  if (direto) return direto;
  const m = radar03Identificacao(p).match(/^([A-Za-zÀ-ÿ0-9.-]+(?:\s+[A-Za-zÀ-ÿ0-9.-]+){0,2})\s+\d/i);
  return m ? m[1].trim() : '';
}

function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (numero) {
    if (numero.includes('/') || !ano) return numero;
    return numero + '/' + ano;
  }
  const m = radar03Identificacao(p).match(/(S\/N|\d+\s*\/\s*\d{2,4}|\/\d{2,4}|\d+)/i);
  return m ? m[1].replace(/\s+/g, '') : '';
}

function radar03BlocoEmail(novas) {
  const seen = new Set();
  return (novas || []).map(p => {
    const tipo = radar03Tipo(p);
    const numero = radar03Numero(p);
    if (!tipo || !numero) return '';
    const row = `${tipo} ${numero}`;
    const key = row.toUpperCase();
    if (seen.has(key)) return '';
    seen.add(key);
    return row;
  }).filter(Boolean).join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PL': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || p?.natureza || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const atual = porTipo.get(tipo);
    if (!atual || partes.numeroInt > atual.numeroInt) {
      porTipo.set(tipo, {
        tipo,
        numeroInt: partes.numeroInt,
        numero: partes.numero,
        ano: partes.ano || String(p?.ano || p?.ano_proposicao || ''),
        ementa: String(p?.ementa || p?.resumo || p?.assunto || '').trim(),
        link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
        clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      });
    }
  });
  return Array.from(porTipo.values());
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      let item = casa.items.find(i => String(i?.tipo || '').toUpperCase() === rec.tipo);
      if (!item) {
        item = { tipo: rec.tipo, base: 0, mon: rec.numeroInt };
        casa.items.push(item);
      }
      const base = Number.parseInt(String(item.base || item.mon || 0), 10) || 0;
      item.tipo = rec.tipo;
      item.mon = rec.numeroInt;
      item.delta = Math.abs(rec.numeroInt - base);
      item.sentido = rec.numeroInt === base ? 'bate com o controle' : 'fonte/sistema acima';
      item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
      item.ementa = rec.ementa || item.ementa || '';
      item.link = rec.link || item.link || '';
      item.clienteSugestao = rec.clienteSugestao || item.clienteSugestao || '';
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({ casa: CASA_RADAR03, bloco: radar03BlocoEmail(novas), fonte: radar03PrimeiraFonte(novas) });
  return `${RADAR03_URL}?${params.toString()}`;
}

function radar03Escape(valor) {
  return String(valor ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return '';
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(proposicoes) {
  anotarClientesCitados(proposicoes);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_REMETENTE,
      pass: process.env.EMAIL_SENHA
    }
  });

  const html = renderRadar03EmailButton(proposicoes) + montarEmail(proposicoes);
  const assunto = `🏛️ Minas Gerais: ${proposicoes.length} nova${proposicoes.length > 1 ? 's' : ''} proposiç${proposicoes.length > 1 ? 'ões' : 'ão'} — ${new Date().toLocaleDateString('pt-BR')}`;

  await transporter.sendMail({
    from: process.env.EMAIL_REMETENTE,
    to: process.env.EMAIL_DESTINO,
    subject: assunto,
    html
  });

  console.log(`Email enviado: "${assunto}"`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Monitor ALMG — ${new Date().toISOString()} ===`);

  const estado = carregarEstado();
  console.log(`Estado carregado: ${estado.proposicoes_vistas.length} proposições conhecidas`);

  const novas = await buscarProposicoesNovas(estado.proposicoes_vistas);
  console.log(`Novas proposições encontradas: ${novas.length}`);

  if (novas.length > 0) {
    await sincronizarRadar03(novas);
    await enviarEmail(novas);

    // Atualiza estado: adiciona novas IDs ao início, mantém histórico razoável
    const todasIds = [...novas.map(p => p.id), ...estado.proposicoes_vistas];
    // Limita a 2000 IDs para não inflar o estado.json indefinidamente
    estado.proposicoes_vistas = [...new Set(todasIds)].slice(0, 2000);
  } else {
    console.log('Nenhuma proposição nova. Email não enviado.');
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
  console.log('Estado salvo.');
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
