import{c as a}from"./input-BbSId_WM.js";async function n(t){if(!t.type.startsWith("image/"))throw new Error("仅支持图片文件");if(t.size>2*1024*1024)throw new Error("文件过大 (最大 2MB)");const r=new FormData;r.append("file",t),r.append("type","post");const o=await fetch("/api/upload",{method:"POST",headers:a("POST",null),body:r}),e=await o.json();if(!o.ok)throw new Error(e?.error||"上传失败");if(!e.url)throw new Error("上传失败");return e.url}async function u(t){const r=t.clipboardData?.items;if(!r?.length)return null;for(const o of Array.from(r)){if(!o.type.startsWith("image/"))continue;const e=o.getAsFile();if(!e)continue;return t.preventDefault(),`

![](${await n(e)})

`}return null}export{u as handleEditorImagePaste,n as uploadPostImage};
