import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { convertPdfToMarkdown, __pdfParserTestables } from '../src/core/ingestion/pdf-parser.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('MinerU executes the selected environment for local and HTTP-client parsing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-mineru-version-'));
  const originalFetch = globalThis.fetch;
  const command = path.join(dir, 'selected-mineru');
  try {
    await fs.writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
fs.mkdirSync(out, {recursive:true});
fs.writeFileSync(path.join(out, 'paper.md'), '# Selected MinerU environment\\n\\nAccuracy 95.2');
fs.writeFileSync(path.join(out, 'args.json'), JSON.stringify(args));
`, { mode: 0o755 });
    const pdf = path.join(dir, 'paper.pdf');
    await fs.writeFile(pdf, 'fixture handled by command stub');
    for (const remote of [false, true]) {
      globalThis.fetch = async () => ({ ok: true, status: 200 });
      const result = await convertPdfToMarkdown(pdf, {
        pdfParser: 'mineru', mineruCommand: command,
        mineruHttpUrl: remote ? 'http://127.0.0.1:39877/v1' : '',
        mineruProbeCacheTtlMs: 0, markerDir: path.join(dir, String(remote)),
        markdownDir: path.join(dir, `markdown-${remote}`),
        pdfParseStateRoot: path.join(dir, 'state'), disableDoclingFallback: true, quiet: true, force: true
      });
      assert.equal(result.parser, 'mineru');
      assert.match(result.parserCommand, /selected-mineru/);
      assert.match(await fs.readFile(result.markdownPath, 'utf8'), /Accuracy 95.2/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('PaddleOCR uses upstream layout defaults and preserves explicit selection', async () => {
  assert.equal(__pdfParserTestables.resolvePaddleOcrVlLayoutModel({}), '');
  assert.equal(__pdfParserTestables.resolvePaddleOcrVlLayoutModel({paddleocrVlLayoutModel: 'PP-DocLayoutV3'}), 'PP-DocLayoutV3');
  await run('python3', ['-c', `
import importlib.util, types
spec=importlib.util.spec_from_file_location('wrapper', 'scripts/paddleocr_vl_to_markdown.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Current:
    def __init__(self, pipeline_version='v1.6', layout_detection_model_name=None): pass
args=types.SimpleNamespace(server_url='http://127.0.0.1/v1',layout_model='')
assert 'layout_detection_model_name' not in m.build_paddleocr_vl_kwargs(Current,args)
args.layout_model='PP-DocLayoutV3'
assert m.build_paddleocr_vl_kwargs(Current,args)['layout_detection_model_name']=='PP-DocLayoutV3'
`], {cwd: root});
});

test('Docling subcommand CLI works through local and generated SSH execution paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-docling-cli-'));
  const command = path.join(dir, 'docling-current');
  try {
    await fs.writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--help') { console.log('Commands: convert convert-remote'); process.exit(0); }
if (args.shift() !== 'convert') { console.error('No such command'); process.exit(2); }
const input = args[0];
const out = args[args.indexOf('--output') + 1];
fs.mkdirSync(out, {recursive:true});
fs.writeFileSync(path.join(out, path.basename(input, '.pdf') + '.md'), '# Current Docling\\n\\nAccuracy 95.2');
`, { mode: 0o755 });
    const pdf = path.join(dir, 'paper.pdf');
    await fs.writeFile(pdf, 'CLI fixture');
    const result = await convertPdfToMarkdown(pdf, {
      pdfParser: 'docling', doclingCommand: command, doclingDevice: 'cpu', doclingAutoGpu: false,
      doclingPreload: false, markerDir: path.join(dir, 'runs'), markdownDir: path.join(dir, 'md'),
      pdfParseStateRoot: path.join(dir, 'state'), quiet: true, force: true
    });
    assert.match(await fs.readFile(result.markdownPath, 'utf8'), /Current Docling/);
    const script = __pdfParserTestables.buildRemoteDoclingScript({
      doclingCommand: command, remotePdfPath: pdf, remoteRunDir: path.join(dir, 'remote', 'out'),
      device: 'cpu', autoGpu: false
    });
    const remote = await run('/bin/sh', ['-c', script]);
    assert.match(remote.stdout, /Current Docling/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Docling VLM sends current engine fields and valid empty headers', async () => {
  await run('python3', ['-c', `
import importlib.util, sys, types, os
spec=importlib.util.spec_from_file_location('wrapper', 'scripts/docling_to_markdown.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def module(name, **attrs): sys.modules[name]=types.SimpleNamespace(**attrs)
class Options:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
class Api(Options):
    def __init__(self, **kwargs):
        assert kwargs['engine_type']=='api'
        assert 'runtime_type' not in kwargs
        assert kwargs['headers']=={}
        assert set(kwargs['params'])=={'model','max_tokens'}
        super().__init__(**kwargs)
class Converter:
    def __init__(self, **kwargs): pass
    def convert(self, path): return types.SimpleNamespace(document=types.SimpleNamespace(export_to_markdown=lambda:'# Parsed'))
module('docling.datamodel.base_models',InputFormat=types.SimpleNamespace(PDF='pdf'))
module('docling.datamodel.pipeline_options',VlmConvertOptions=types.SimpleNamespace(from_preset=lambda preset,**kwargs:Options(**kwargs)),VlmPipelineOptions=Options)
module('docling.datamodel.vlm_engine_options',ApiVlmEngineOptions=Api,VlmEngineType=types.SimpleNamespace(API='api'))
module('docling.document_converter',DocumentConverter=Converter,PdfFormatOption=Options)
module('docling.pipeline.vlm_pipeline',VlmPipeline=object)
os.environ.pop('PAPERNEXUS_DOCLING_VLM_API_KEY',None)
args=types.SimpleNamespace(base_url='http://127.0.0.1/v1',model_name='test',max_tokens=512,vlm_preset='granite_docling',input='fixture.pdf')
assert m.convert_vlm(args)=='# Parsed'
`], {cwd: root});
});

test('MarkPDFDown forwards the selected DeepSeek credentials to LiteLLM', async () => {
  await run('python3', ['-c', `
import importlib.util, types, os
spec=importlib.util.spec_from_file_location('wrapper','scripts/markpdfdown_to_markdown.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
os.environ['OPENAI_API_KEY']='test-selected-key'
args=types.SimpleNamespace(provider='deepseek',base_url='http://127.0.0.1/v1',api_key='',model_name='deepseek/test',temperature=0.3,max_tokens=512,retry_times=1)
m.configure_environment(args)
assert os.environ['DEEPSEEK_API_KEY']=='test-selected-key'
assert os.environ['DEEPSEEK_API_BASE']=='http://127.0.0.1/v1'
`], {cwd: root});
});

test('runtime audit detects a wrong MarkPDFDown source despite matching package version', async () => {
  await run('python3', ['-c', `
import importlib.util, tempfile, pathlib, sys, json, subprocess
spec=importlib.util.spec_from_file_location('runtime','scripts/pdf-parser-runtime.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.subprocess.run
m.subprocess.run=lambda *a,**k:types.SimpleNamespace(stdout=json.dumps({'version':'1.1.2','directUrl':{'url':'https://example.com/wrong.zip'}}))
import types
spec={'distribution':'markpdfdown','version':'1.1.2','revision':'2e34a1b0b0a1f4e60b53164bd85988a3b399f06b'}
assert not m.inspect_runtime(sys.executable,spec)['aligned']
spec['requirements']=['markpdfdown @ https://github.com/MarkPDFdown/markpdfdown/archive/'+spec['revision']+'.zip']
m.subprocess.run=lambda *a,**k:types.SimpleNamespace(stdout=json.dumps({'version':'1.1.2','directUrl':{'url':'https://example.com/'+spec['revision']+'.zip'}}))
assert not m.inspect_runtime(sys.executable,spec)['aligned']
`], {cwd: root});
});
