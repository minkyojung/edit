---
source: https://milkdown.dev/docs/api/plugin-upload
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-upload"
---

# @milkdown/plugin-upload

Upload and create image (or any file types you like) when drop.

```typescript
import { Editor } from '@milkdown/kit/core'
import { upload } from '@milkdown/kit/plugin/upload'

Editor.make().use(upload).create()
```

 #### upload `: MilkdownPlugin[]`
   All plugins exported by this package.


---

## Upload Config

By default, this plugin will transform image to base64 and ignore other file types.
If you want to upload file and handle the generated blocks, you should setup the uploader.

```typescript
import { upload, uploadConfig, Uploader } from '@milkdown/kit/plugin/upload'
import type { Node } from '@milkdown/kit/prose/model'

const uploader: Uploader = async (files, schema) => {
  const images: File[] = []

  for (let i = 0; i < files.length; i++) {
    const file = files.item(i)
    if (!file) {
      continue
    }

    // You can handle whatever the file type you want, we handle image here.
    if (!file.type.includes('image')) {
      continue
    }

    images.push(file)
  }

  const nodes: Node[] = await Promise.all(
    images.map(async (image) => {
      const src = await YourUploadAPI(image)
      const alt = image.name
      return schema.nodes.image.createAndFill({
        src,
        alt,
      }) as Node
    })
  )

  return nodes
}

Editor.make()
  .config((ctx) => {
    ctx.update(uploadConfig.key, (prev) => ({
      ...prev,
      uploader,
    }))
  })
  .use(upload)
  .create()
```

 #### uploadPlugin `: $Prose`
   The prosemirror plugin for upload.


 #### uploadConfig `: $Ctx`
   A slice that contains the configuration for upload.
   It should be typed of `UploadConfig`.

#### interface UploadOptions



The configuration for upload.

 * **`uploader`**`(files: FileList, schema: Schema, ctx: Ctx, insertPos: number) → Promise`\
   The uploader for upload plugin.
   It takes the files / schema / ctx / insertPos as parameters.
   It should return a `Promise` of Prosemirror `Fragment` or `Node` or `Node[]`.

 * **`enableHtmlFileUploader`**`: boolean`\
   Whether to enable the html file uploader.
   When paste files from html (for example copy images by right click context menu),
   this option will make the plugin to upload the image copied instead of using the original link.

 * **`uploadWidgetFactory`**`(pos: number, spec: Object | undefined) → Decoration`\
   The factory for upload widget.
   The widget will be displayed when the file is uploading.
   It takes the position and spec as parameters.
   It should return a `Decoration` of Prosemirror.
   By default, it will return `<span>Upload in progress...</span>`.

 * **`getInsertPos`**`?: fn(event: ClipboardEvent | DragEvent, ctx: Ctx, defaultInsertPos: number) → number`


---

## Utils

 #### defaultUploader `(files: FileList, schema: Schema, ctx: Ctx, insertPos: number) → Promise`
   The default uploader.
   It will upload transform images to base64.


 #### readImageAsBase64 `(file: File) → Promise`
   Read the image file as base64.
