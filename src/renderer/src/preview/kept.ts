/**
 * The latest `limit` answers by key, kept while `keep` says so; an answer
 * still on its way is shared by everyone who asks for its key.
 */
export function keptAnswers<T>(limit: number, keep: (answer: T) => boolean) {
  const answers = new Map<string, Promise<T>>()
  return (key: string, ask: () => Promise<T>): Promise<T> => {
    const known = answers.get(key)
    if (known) {
      answers.delete(key)
      answers.set(key, known)
      return known
    }
    const answer = ask()
    answers.set(key, answer)
    if (answers.size > limit) answers.delete(answers.keys().next().value!)
    const forget = () => {
      if (answers.get(key) === answer) answers.delete(key)
    }
    answer.then((value) => {
      if (!keep(value)) forget()
    }, forget)
    return answer
  }
}
