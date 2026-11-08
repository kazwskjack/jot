import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {remarkTwemoji} from './remark-twemoji.mjs';

export default function TwemojiMarkdown({children}:{children:string}){
 return <Markdown remarkPlugins={[remarkGfm,remarkTwemoji]} skipHtml>{children}</Markdown>;
}
