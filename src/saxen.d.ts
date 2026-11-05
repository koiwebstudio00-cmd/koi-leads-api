declare module 'saxen' {
  export class Parser {
    on(event: 'openTag', callback: (name: string, attrs: () => Record<string,string>, decode: (value:string) => string) => void): this
    on(event: 'error' | 'warn', callback: (error: Error) => void): this
    parse(xml: string): void
  }
}
