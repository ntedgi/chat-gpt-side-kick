interface Animal {
    move()
    eat()
    talk()
}

class Dog implements Animal {
    move() {
        console.log("the dog is walking")
    }
    eat() {
        console.log("the dog eating a bone")
    }
    talk() {
        console.log("the dog say woof")
    }

}
class Cat implements Animal {
    move() {
        console.log("the cat is walking")
    }
    eat() {
        console.log("the cat eating milk")
    }
    talk() {
        console.log("the cat say meow")
    }

}

class Fish implements Animal {
    move() {
        console.log("the fish is swimming")
    }
    eat() {
        console.log("the fish eats small fishes")
    }
    talk() {
        console.log("the fish say blop")
    }

}


// i want to force the model to create  genrealzation for Bird
// then to create human class 
// then refactor interfaces to Movable,Eatable...

