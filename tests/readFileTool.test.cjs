const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileTool } = require('../dist/extension/backend/world/modules/tools/definitions/readFile/index.js');

function createDeps() {
  const calls = {
    binary: [],
    text: []
  };
  const deps = {
    fs: {
      async readBinaryFile(path, mimeType, options) {
        calls.binary.push({ path, mimeType, options });
        return {
          path: `C:/workspace/${path}`,
          name: path.split('/').at(-1),
          mimeType,
          data: 'base64-data',
          sizeBytes: 1234
        };
      },
      async readFile(path, startLine, endLine, options) {
        calls.text.push({ path, startLine, endLine, options });
        return {
          path,
          startLine: startLine ?? 1,
          endLine: endLine ?? 2,
          totalLines: 2,
          lines: [
            { line: 1, text: 'first' },
            { line: 2, text: 'second' }
          ],
          content: '1 first\n2 second'
        };
      }
    }
  };
  return { calls, deps };
}

test('read schema keeps mode optional and documents text as the default', () => {
  const parameters = readFileTool.declaration.parameters;
  assert.deepEqual(parameters.required, ['path']);
  assert.deepEqual(parameters.properties.mode.enum, ['text', 'attachment']);
  assert.match(parameters.properties.mode.description, /Defaults to "text"/);
});

test('omitted mode defaults to text reading', async () => {
  const { calls, deps } = createDeps();
  const result = await readFileTool.execute({
    path: 'notes.md',
    startLine: 0,
    endLine: 0
  }, deps);

  assert.equal(result.ok, true);
  assert.equal(calls.binary.length, 0);
  assert.equal(calls.text.length, 1);
  assert.equal(calls.text[0].startLine, undefined);
  assert.equal(calls.text[0].endLine, undefined);
});

test('invalid mode is rejected instead of silently falling back to text', async () => {
  const { calls, deps } = createDeps();
  const result = await readFileTool.execute({
    path: 'notes.md',
    mode: 'binary'
  }, deps);

  assert.equal(result.ok, false);
  assert.match(String(result.output), /Invalid argument: mode/);
  assert.equal(calls.binary.length, 0);
  assert.equal(calls.text.length, 0);
});

for (const lineArgs of [
  { startLine: 0, endLine: 0 },
  { startLine: 1, endLine: 1 }
]) {
  test(`attachment mode ignores line arguments ${JSON.stringify(lineArgs)}`, async () => {
    const { calls, deps } = createDeps();
    const result = await readFileTool.execute({
      path: 'images/example.JPG',
      mode: 'attachment',
      ...lineArgs
    }, deps, {
      settingsSnapshot: { enableMultimodalTools: true }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { mimeType: 'image/jpeg', sizeBytes: 1234 });
    assert.equal(calls.text.length, 0);
    assert.equal(calls.binary.length, 1);
    assert.equal(calls.binary[0].path, 'images/example.JPG');
    assert.equal(calls.binary[0].mimeType, 'image/jpeg');
    assert.equal(result.parts.length, 1);
    assert.deepEqual(result.parts[0].inlineData, {
      mimeType: 'image/jpeg',
      data: 'base64-data',
      name: 'example.JPG',
      sourcePath: 'C:/workspace/images/example.JPG',
      storage: 'embedded',
      status: 'available',
      sizeBytes: 1234
    });
  });
}

test('text mode treats non-positive line numbers as omitted', async () => {
  const { calls, deps } = createDeps();
  const result = await readFileTool.execute({
    path: 'notes.md',
    mode: 'text',
    startLine: 0,
    endLine: -1
  }, deps);

  assert.equal(result.ok, true);
  assert.equal(calls.binary.length, 0);
  assert.equal(calls.text.length, 1);
  assert.equal(calls.text[0].startLine, undefined);
  assert.equal(calls.text[0].endLine, undefined);
});

test('text mode refuses known image and PDF extensions', async () => {
  const { calls, deps } = createDeps();
  const result = await readFileTool.execute({
    path: 'images/example.jpg',
    mode: 'text',
    startLine: 1,
    endLine: 1
  }, deps);

  assert.equal(result.ok, false);
  assert.match(String(result.output), /mode="attachment"/);
  assert.equal(calls.binary.length, 0);
  assert.equal(calls.text.length, 0);
});

test('attachment mode rejects unsupported extensions instead of reading text', async () => {
  const { calls, deps } = createDeps();
  const result = await readFileTool.execute({
    path: 'images/example.svg',
    mode: 'attachment',
    startLine: 0,
    endLine: 0
  }, deps);

  assert.equal(result.ok, false);
  assert.match(String(result.output), /only supports/);
  assert.equal(calls.binary.length, 0);
  assert.equal(calls.text.length, 0);
});

test('attachment mode respects the multimodal tools setting', async () => {
  const { calls, deps } = createDeps();
  const result = await readFileTool.execute({
    path: 'document.pdf',
    mode: 'attachment',
    startLine: 0,
    endLine: 0
  }, deps, {
    settingsSnapshot: { enableMultimodalTools: false }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'warning');
  assert.match(String(result.output), /未启用多模态工具/);
  assert.equal(calls.binary.length, 0);
  assert.equal(calls.text.length, 0);
});
