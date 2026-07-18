import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import express from 'express';
import https from 'https';

const NOCKEE_KEY = process.env.NOCKEE_API_KEY || 'Uw5SReDnLWK99u3qcbtFEJzLPinvua7IMkF1DuTbBH8iEkNTVC';
const MCP_SECRET = process.env.MCP_SECRET;
const PORT = process.env.PORT || 3000;

function nockee(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.nockee.eu', path: '/v2' + path, method,
      headers: { 'X-Api-Key': NOCKEE_KEY, 'Content-Type': 'application/json' }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function deleteAllPictures(reportId) {
  let total = 0;
  for (const type of ['element', 'key', 'global', 'global_key', 'meter', 'room']) {
    let cursor = null;
    while (true) {
      let url = `/inspection_report_pictures?inspection_report=${reportId}&type=${type}&limit=100`;
      if (cursor) url += `&cursor=${cursor}`;
      const r = await nockee('GET', url);
      if (!r.data?.length) break;
      for (const pic of r.data) { await nockee('DELETE', `/inspection_report_pictures/${pic.id}`); total++; }
      cursor = r.next_cursor;
      if (!cursor) break;
    }
  }
  return total;
}

async function deleteAllSignatories(reportId) {
  const sigs = await nockee('GET', `/inspection_report_signatories?inspection_report=${reportId}&limit=50`);
  let count = 0;
  for (const sig of (sigs.data || [])) {
    await nockee('DELETE', `/inspection_report_signatories/${sig.id}`);
    count++;
  }
  return count;
}

const server = new McpServer({ name: 'nockee', version: '1.0.0' });

server.tool(
  'nockee_list_reports',
  'List Nockee reports. Use to search for a previous EDL at a given address. Returns id, type, date, address, floor, reference (owner), tenants.',
  {
    limit: z.number().optional().describe('Max results (default 100, max 100)'),
    cursor: z.string().optional().describe('Pagination cursor'),
  },
  async ({ limit = 100, cursor }) => {
    let url = `/inspection_reports?limit=${limit}`;
    if (cursor) url += `&cursor=${cursor}`;
    const r = await nockee('GET', url);
    const items = (r.data || []).map(x => ({
      id: x.id,
      type: x.type,
      scheduled_date: x.scheduled_date,
      address: x.property?.address,
      surface: x.property?.surface_area,
      rooms: x.property?.rooms_count,
      furnished: x.property?.furnished,
      reference: x.property?.reference,
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ items, next_cursor: r.next_cursor }, null, 2) }] };
  }
);

server.tool(
  'nockee_get_report',
  'Get full details of a Nockee report (property, type, date) and its signatories (representative, owner, tenants).',
  { report_id: z.string().describe('UUID of the Nockee report') },
  async ({ report_id }) => {
    const [r, sigs] = await Promise.all([
      nockee('GET', `/inspection_reports/${report_id}`),
      nockee('GET', `/inspection_report_signatories?inspection_report=${report_id}&limit=20`)
    ]);
    return { content: [{ type: 'text', text: JSON.stringify({ report: r, signatories: sigs.data }, null, 2) }] };
  }
);

server.tool(
  'nockee_create_report',
  'Create an EDL report in Nockee. If from_report_id is provided, clones that report (include_photos always false). Otherwise creates from scratch with the provided address.',
  {
    type: z.enum(['residential_lease_check_in', 'residential_lease_check_out'])
      .describe('check_in = EDLE (entry), check_out = EDLS (exit)'),
    scheduled_date: z.string().describe('Appointment date YYYY-MM-DD'),
    from_report_id: z.string().optional().describe('UUID of source report for cloning (include_photos always false)'),
    address_line1: z.string().optional().describe('Address line 1 (required if from scratch)'),
    address_postal_code: z.string().optional(),
    address_city: z.string().optional(),
    address_floor: z.number().optional().describe('Floor number'),
    address_door: z.string().optional().describe('Door number / indication (e.g. Droite, B712A)'),
  },
  async ({ type, scheduled_date, from_report_id, address_line1, address_postal_code, address_city, address_floor, address_door }) => {
    const body = { type, scheduled_date };
    if (from_report_id) {
      body.from_inspection_report = { inspection_report: from_report_id, include_photos: false };
    } else {
      const address = {};
      if (address_line1) address.line_1 = address_line1;
      if (address_postal_code) address.postal_code = address_postal_code;
      if (address_city) address.city = address_city;
      if (address_floor !== undefined) address.floor_number = address_floor;
      if (address_door) address.door = address_door;
      body.property = { address };
    }
    const r = await nockee('POST', '/inspection_reports', body);
    if (!r.id) return { content: [{ type: 'text', text: 'ERROR: ' + JSON.stringify(r) }], isError: true };
    let photos_deleted = 0;
    if (from_report_id) photos_deleted = await deleteAllPictures(r.id);
    return { content: [{ type: 'text', text: JSON.stringify({ id: r.id, type: r.type, photos_deleted }, null, 2) }] };
  }
);

server.tool(
  'nockee_patch_report',
  'Update property info on a Nockee report (property type, surface, rooms, furnished, owner reference, floor, door). Call right after creation while report is still draft.',
  {
    report_id: z.string().describe('UUID of the report'),
    property_type: z.string().optional().describe('Property type: flat, house, parking, commercial'),
    furnished: z.boolean().optional().describe('Furnished (true) or empty (false)'),
    surface_area: z.number().optional().describe('Surface area in sqm'),
    rooms_count: z.number().optional().describe('Number of rooms'),
    reference: z.string().optional().describe('Reference = real property owner name'),
    address_floor: z.number().optional().describe('Floor number'),
    address_door: z.string().optional().describe('Door number / indication'),
    address_line1: z.string().optional().describe('Address line 1 (if correction needed)'),
    address_postal_code: z.string().optional(),
    address_city: z.string().optional(),
  },
  async ({ report_id, property_type, furnished, surface_area, rooms_count, reference, address_floor, address_door, address_line1, address_postal_code, address_city }) => {
    const property = {};
    if (property_type !== undefined) property.type = property_type;
    if (furnished !== undefined) property.furnished = furnished;
    if (surface_area !== undefined) property.surface_area = surface_area;
    if (rooms_count !== undefined) property.rooms_count = rooms_count;
    if (reference !== undefined) property.reference = reference;
    const address = {};
    if (address_floor !== undefined) address.floor_number = address_floor;
    if (address_door !== undefined) address.door = address_door;
    if (address_line1 !== undefined) address.line_1 = address_line1;
    if (address_postal_code !== undefined) address.postal_code = address_postal_code;
    if (address_city !== undefined) address.city = address_city;
    if (Object.keys(address).length) property.address = address;
    const r = await nockee('PATCH', `/inspection_reports/${report_id}`, { property });
    if (!r.id) return { content: [{ type: 'text', text: 'ERROR: ' + JSON.stringify(r) }], isError: true };
    return { content: [{ type: 'text', text: 'OK - report ' + r.id + ' updated' }] };
  }
);

server.tool(
  'nockee_delete_report',
  'Permanently delete a Nockee report (only if in draft).',
  { report_id: z.string().describe('UUID of the report to delete') },
  async ({ report_id }) => {
    const r = await nockee('DELETE', `/inspection_reports/${report_id}`);
    return { content: [{ type: 'text', text: 'Deleted: ' + report_id + ' - ' + JSON.stringify(r) }] };
  }
);

server.tool(
  'nockee_list_signatories',
  'Returns the list of signatories of a report (representative, owner, tenants). Useful to check or retrieve owner info from a cloned report.',
  { report_id: z.string().describe('UUID of the report') },
  async ({ report_id }) => {
    const r = await nockee('GET', `/inspection_report_signatories?inspection_report=${report_id}&limit=20`);
    return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
  }
);

server.tool(
  'nockee_add_signatory',
  'Add a signatory to a Nockee report. Types: representative (EPI mandate), owner (landlord), tenant. Never include address for tenants.',
  {
    report_id: z.string().describe('UUID of the report'),
    type: z.enum(['representative', 'owner', 'tenant']).describe('representative=mandate, owner=landlord, tenant=tenant'),
    person_type: z.enum(['legal_person', 'natural_person']).describe('legal_person=company, natural_person=individual'),
    last_name: z.string().optional(),
    first_name: z.string().optional(),
    email: z.string().optional(),
    company_name: z.string().optional().describe('Trade name (for EPI EXPERTISES)'),
    legal_name: z.string().optional().describe('Legal name (for landlord legal persons)'),
    address_line1: z.string().optional().describe('Address (DO NOT set for tenants)'),
    address_postal_code: z.string().optional(),
    address_city: z.string().optional(),
  },
  async ({ report_id, type, person_type, last_name, first_name, email, company_name, legal_name, address_line1, address_postal_code, address_city }) => {
    const sig = { inspection_report: report_id, type, person_type };
    if (last_name) sig.last_name = last_name;
    if (first_name) sig.first_name = first_name;
    if (email) sig.email = email;
    if (company_name) sig.company_name = company_name;
    if (legal_name) sig.legal_name = legal_name;
    if (address_line1) sig.address = { line_1: address_line1, postal_code: address_postal_code, city: address_city };
    const r = await nockee('POST', '/inspection_report_signatories', sig);
    if (!r.id) return { content: [{ type: 'text', text: 'ERROR: ' + JSON.stringify(r) }], isError: true };
    return { content: [{ type: 'text', text: 'Signatory added: ' + r.id + ' (' + type + ' ' + (last_name || legal_name || '') + ')' }] };
  }
);

server.tool(
  'nockee_delete_signatory',
  'Delete a signatory by id.',
  { signatory_id: z.string().describe('UUID of the signatory') },
  async ({ signatory_id }) => {
    await nockee('DELETE', `/inspection_report_signatories/${signatory_id}`);
    return { content: [{ type: 'text', text: 'Deleted: ' + signatory_id }] };
  }
);

server.tool(
  'nockee_clear_signatories',
  'Delete ALL signatories from a report (useful after cloning, before adding new ones).',
  { report_id: z.string().describe('UUID of the report') },
  async ({ report_id }) => {
    const count = await deleteAllSignatories(report_id);
    return { content: [{ type: 'text', text: `${count} signatory(ies) deleted` }] };
  }
);

const app = express();
app.use(express.json());

app.use('/mcp', (req, res, next) => {
  if (!MCP_SECRET) return next();
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${MCP_SECRET}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

app.all('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/', (req, res) => res.json({ status: 'ok', name: 'mcp-nockee', version: '1.0.0' }));

app.listen(PORT, () => console.log(`MCP Nockee started on port ${PORT}`));
