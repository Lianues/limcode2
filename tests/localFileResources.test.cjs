const assert = require('node:assert/strict');
const test = require('node:test');
const MarkdownIt = require('markdown-it');

const {
  LOCAL_FILE_LINK_DATA_ATTRIBUTE,
  LOCAL_RESOURCE_MAPPINGS_META_NAME,
  normalizeLocalFileSource,
  toMappedWebviewResourceUri
} = require('../dist/extension/shared/localFileResources.js');

test('本地资源 meta 与文件链接属性使用共享协议常量', () => {
  assert.equal(LOCAL_RESOURCE_MAPPINGS_META_NAME, 'limcode-local-resource-mappings');
  assert.equal(LOCAL_FILE_LINK_DATA_ATTRIBUTE, 'data-limcode-local-file');
});

test('Windows Markdown token 会先解码反斜杠再识别绝对路径', () => {
  assert.equal(normalizeLocalFileSource('F:%5Ca%5Cb.png'), 'F:/a/b.png');
  assert.equal(normalizeLocalFileSource('f:\\Shots\\a b.png'), 'F:/Shots/a b.png');
  assert.equal(normalizeLocalFileSource('file:///F:/Shots/a%20b.png'), 'F:/Shots/a b.png');
});

test('实际 markdown-it token 的 Windows 与 UNC 编码结果可被识别', () => {
  const parser = new MarkdownIt();
  const defaultValidateLink = parser.validateLink.bind(parser);
  parser.validateLink = (url) => /^file:/i.test(url) || defaultValidateLink(url);
  const tokenSource = (markdown, type, attribute) => parser.parse(markdown, {})
    .flatMap((token) => token.children || [])
    .find((token) => token.type === type)
    ?.attrs?.find(([name]) => name === attribute)?.[1];

  const windowsImage = tokenSource(String.raw`![](F:\a\b.png)`, 'image', 'src');
  const uncImage = tokenSource(String.raw`![](\\server\share\a.png)`, 'image', 'src');
  const windowsLink = tokenSource(String.raw`[open](F:\a\b.txt)`, 'link_open', 'href');
  assert.equal(windowsImage, 'F:%5Ca%5Cb.png');
  assert.equal(uncImage, '%5Cserver%5Cshare%5Ca.png');
  assert.equal(windowsLink, 'F:%5Ca%5Cb.txt');
  assert.equal(normalizeLocalFileSource(windowsImage), 'F:/a/b.png');
  assert.equal(normalizeLocalFileSource(uncImage), '//server/share/a.png');
  assert.equal(normalizeLocalFileSource(windowsLink), 'F:/a/b.txt');
});

test('POSIX 与 UNC 本地路径被规范化，网页和相对路径不会误判', () => {
  assert.equal(normalizeLocalFileSource('/tmp/a%20b.png'), '/tmp/a b.png');
  assert.equal(normalizeLocalFileSource('\\\\server\\share\\folder\\a.png'), '//server/share/folder/a.png');
  assert.equal(normalizeLocalFileSource('%5Cserver%5Cshare%5Cfolder%5Ca.png'), '//server/share/folder/a.png');
  assert.equal(normalizeLocalFileSource('file://server/share/folder/a.png'), '//server/share/folder/a.png');
  assert.equal(normalizeLocalFileSource('https://example.com/a.png'), undefined);
  assert.equal(normalizeLocalFileSource('data:image/png;base64,AAAA'), undefined);
  assert.equal(normalizeLocalFileSource('images/a.png'), undefined);
});

test('资源映射按最长前缀、路径边界和大小写规则生成 Webview URI', () => {
  const mappings = [
    {
      pathPrefix: 'F:/',
      resourceBase: 'https://file+.vscode-resource.vscode-cdn.net/f%3A/',
      caseSensitive: false
    },
    {
      pathPrefix: '//server/share/project',
      resourceBase: 'https://file+server.vscode-resource.vscode-cdn.net/share/project/',
      caseSensitive: false
    },
    {
      pathPrefix: '/home',
      resourceBase: 'https://remote.example/home/',
      caseSensitive: true
    }
  ];

  assert.equal(
    toMappedWebviewResourceUri('f:\\Shots\\a b.png', mappings),
    'https://file+.vscode-resource.vscode-cdn.net/f%3A/Shots/a%20b.png'
  );
  assert.equal(
    toMappedWebviewResourceUri('F:%5CShots%5Ca%20b.png', mappings),
    'https://file+.vscode-resource.vscode-cdn.net/f%3A/Shots/a%20b.png'
  );

  assert.equal(
    toMappedWebviewResourceUri('file://server/share/project/assets/a b.png', mappings),
    'https://file+server.vscode-resource.vscode-cdn.net/share/project/assets/a%20b.png'
  );
  assert.equal(
    toMappedWebviewResourceUri('%5Cserver%5Cshare%5Cproject%5Cassets%5Ca.png', mappings),
    'https://file+server.vscode-resource.vscode-cdn.net/share/project/assets/a.png'
  );

  assert.equal(
    toMappedWebviewResourceUri('/home/user/a#b.png', mappings),
    'https://remote.example/home/user/a%23b.png'
  );
  assert.equal(toMappedWebviewResourceUri('/homepage/a.png', mappings), undefined);
});
