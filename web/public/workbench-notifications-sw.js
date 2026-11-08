self.addEventListener('push',event=>{
 event.waitUntil(self.registration.showNotification('Jot 任务更新',{
  body:'你有一条任务更新，请打开 Jot 查看。',
  data:{url:'/workbench.html'},
 }));
});

self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const target=new URL('/workbench.html',self.location.origin).href;
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const client of clients){
   const url=new URL(client.url);
   if(url.origin===self.location.origin&&url.pathname==='/workbench.html')return client.focus();
  }
  return self.clients.openWindow(target);
 })());
});
