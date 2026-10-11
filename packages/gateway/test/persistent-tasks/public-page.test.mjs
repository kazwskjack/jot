import assert from 'node:assert/strict';
import test from 'node:test';
import { readPublicPage, publicAddress, validatePageUrl } from '../../src/persistent-tasks/public-page.ts';

test('pinned DNS lookup supports Node socket single and all-address callback forms',async()=>{
  const {pinnedLookup}=await import('../../src/persistent-tasks/public-page.ts');assert.equal(typeof pinnedLookup,'function');
  const lookup=pinnedLookup({address:'8.8.8.8',family:4});
  lookup('example.com',{all:false},(err,address,family)=>{assert.equal(err,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
  lookup('example.com',{all:true},(err,addresses)=>{assert.equal(err,null);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);});
});

test('public address policy excludes local, reserved, mapped and transition networks',()=>{
  for(const ip of ['127.0.0.1','10.1.1.1','172.16.0.1','169.254.169.254','192.168.0.1','100.64.1.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::']) assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  for(const url of ['file:///etc/passwd','http://localhost/','http://0x7f000001/','http://test-user:test-password@example.com/','http://example.com:8080/']) assert.throws(()=>validatePageUrl(url),/unsafe_page_url/);
});
test('redirect destination is checked before transport and mixed DNS answers fail closed',async()=>{
  let requests=0;
  const options={resolve:async()=>[{address:'8.8.8.8',family:4}],request:async()=>{requests++;return{status:302,location:'http://127.0.0.1/',text:''};}};
  await assert.rejects(()=>readPublicPage('https://example.com/',options),/unsafe_page_url/);assert.equal(requests,1);
  await assert.rejects(()=>readPublicPage('https://example.com/',{...options,resolve:async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]}),/unsafe_page_url/);assert.equal(requests,1);
});
test('each redirect resolves again and transport receives pinned public address',async()=>{
  const hosts=[];const addresses=[];
  const result=await readPublicPage('https://example.com/',{resolve:async host=>{hosts.push(host);return[{address:'8.8.4.4',family:4}];},request:async(url,address)=>{addresses.push(address.address);return url.hostname==='example.com' ? {status:302,location:'https://other.example.org/new',text:''}:{status:200,contentType:'text/html',text:'  changed\r\npage  '};}});
  assert.deepEqual(hosts,['example.com','other.example.org']);assert.deepEqual(addresses,['8.8.4.4','8.8.4.4']);assert.equal(result.text,'changed\npage');
});
test('reader caps body size and redirect chains and rejects binary content',async()=>{
  const resolve=async()=>[{address:'8.8.8.8',family:4}];
  await assert.rejects(()=>readPublicPage('https://example.com/',{resolve,request:async()=>({status:200,contentType:'text/html',text:'x'.repeat(262145)})}),/page_too_large/);
  await assert.rejects(()=>readPublicPage('https://example.com/',{resolve,request:async()=>({status:200,contentType:'image/png',text:'x'})}),/page_content_type/);
  await assert.rejects(()=>readPublicPage('https://example.com/',{resolve,request:async()=>({status:302,location:'/again',text:''})}),/page_redirect_limit/);
});
